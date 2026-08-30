/**
 * Kiln — single Worker project
 * -----------------------------
 * This ONE Worker does two jobs:
 *   1. Serves the static site (everything in /public, i.e. index.html)
 *      for normal page loads.
 *   2. Handles POST /process — the fallback path for files too big/slow
 *      for the browser's own ffmpeg.wasm.
 *
 * Because it's all one project, there's nothing to configure on the
 * frontend: the "processing endpoint" is just this same site's own
 * /process route, automatically, same-origin, no URL to copy-paste.
 *
 * IMPORTANT — read this part:
 * Workers run in a sandboxed JS runtime and cannot execute native
 * binaries (no real `ffmpeg` process). So /process does NOT transcode
 * anything itself. It streams the incoming file (or fetches a URL you
 * gave it) straight through to a REAL backend you run separately —
 * a small VPS/container that actually has ffmpeg installed — and
 * streams the result back. Nothing is written to disk at any point.
 *
 * Until you deploy that separate backend and set BACKEND_URL (see
 * README), /process will just return a clear "not configured" error.
 * That's expected — client-side ffmpeg.wasm already handles most files
 * on its own, so you may never need this at all.
 *
 * Zero-log policy: this file never logs request URLs, IPs, filenames,
 * or bodies. Don't add any `console.log` of that data.
 */

const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB ceiling — tune to your backend

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/process') {
      return handleProcess(request, env);
    }

    // Everything else: serve the static files in /public (index.html etc)
    return env.ASSETS.fetch(request);
  },
};

async function handleProcess(request, env) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: cors });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: cors });
  }

  const backendUrl = env.BACKEND_URL;
  if (!backendUrl) {
    return new Response(
      'No BACKEND_URL configured on this Worker yet. /process only relays jobs to a ' +
      'real transcoding backend you run yourself — see the comment at the top of ' +
      'worker.js and the README. Until then, client-side processing (the default) ' +
      'handles everything on its own.',
      { status: 501, headers: cors }
    );
  }

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength && contentLength > MAX_BYTES) {
    return new Response('File too large for this instance.', { status: 413, headers: cors });
  }

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return new Response('Malformed request body.', { status: 400, headers: cors });
  }

  const mode = String(form.get('mode') || 'video');
  const quality = String(form.get('quality') || '');
  const container = String(form.get('container') || 'mp4');
  const audioFmt = String(form.get('audioFmt') || 'mp3');
  const bitrate = String(form.get('bitrate') || '');
  const embedMeta = String(form.get('embedMeta') || '1');
  const sourceUrl = form.get('sourceUrl');
  const file = form.get('file');

  if (!sourceUrl && !file) {
    return new Response('No file or sourceUrl provided.', { status: 400, headers: cors });
  }

  const outbound = new FormData();
  outbound.set('mode', mode);
  outbound.set('quality', quality);
  outbound.set('container', container);
  outbound.set('audioFmt', audioFmt);
  outbound.set('bitrate', bitrate);
  outbound.set('embedMeta', embedMeta);

  if (sourceUrl) {
    // Only ever a URL the user's own browser already had — this never
    // parses or special-cases any third-party platform link.
    let sourceRes;
    try {
      sourceRes = await fetch(String(sourceUrl));
    } catch (e) {
      return new Response('Could not fetch the provided source URL.', { status: 502, headers: cors });
    }
    if (!sourceRes.ok) {
      return new Response('Source URL returned an error.', { status: 502, headers: cors });
    }
    const blob = await sourceRes.blob();
    if (blob.size > MAX_BYTES) {
      return new Response('Source file too large.', { status: 413, headers: cors });
    }
    outbound.set('file', blob, sourceUrlFilename(String(sourceUrl)));
  } else {
    outbound.set('file', file, file.name || 'input');
  }

  let backendRes;
  try {
    backendRes = await fetch(backendUrl.replace(/\/$/, '') + '/transcode', {
      method: 'POST',
      body: outbound,
    });
  } catch (e) {
    return new Response('Backend unreachable.', { status: 502, headers: cors });
  }

  if (!backendRes.ok || !backendRes.body) {
    return new Response('Backend processing failed.', { status: 502, headers: cors });
  }

  const headers = new Headers(cors);
  headers.set('Content-Type', backendRes.headers.get('content-type') || 'application/octet-stream');
  const cd = backendRes.headers.get('content-disposition');
  if (cd) headers.set('Content-Disposition', cd);

  // Streamed straight through — never buffered to disk.
  return new Response(backendRes.body, { status: 200, headers });
}

function sourceUrlFilename(u) {
  try {
    const p = new URL(u).pathname;
    return p.split('/').pop() || 'source';
  } catch (e) {
    return 'source';
  }
}
