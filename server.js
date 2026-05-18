const crypto = require('crypto');
const fs = require('fs/promises');
const http = require('http');
const path = require('path');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const DEFAULT_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2';
const DEFAULT_VOICE = process.env.OPENAI_REALTIME_VOICE || 'alloy';
const DEFAULT_INSTRUCTIONS = process.env.OPENAI_REALTIME_INSTRUCTIONS || [
  'You are a concise, helpful voice agent demo.',
  'Keep replies short and natural unless the user asks for detail.',
  'Ask one focused clarifying question when necessary.',
].join(' ');
const SAFETY_IDENTIFIER = process.env.OPENAI_SAFETY_IDENTIFIER || crypto.createHash('sha256').update('demo_voice_agent').digest('hex');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');

    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Request body is too large.'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('Request body must be valid JSON.'));
      }
    });

    req.on('error', reject);
  });
}

function normalizePath(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const normalized = path.posix.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  return normalized === '/' ? '/index.html' : normalized;
}

async function serveStatic(urlPath, res, headOnly = false) {
  const safePath = normalizePath(urlPath);
  const relativePath = safePath.startsWith('/') ? safePath.slice(1) : safePath;
  const filePath = path.join(PUBLIC_DIR, relativePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return true;
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': contentType,
    });
    res.end(headOnly ? undefined : data);
    return true;
  } catch (error) {
    const ext = path.extname(filePath);
    if (!ext) {
      try {
        const indexPath = path.join(PUBLIC_DIR, 'index.html');
        const data = await fs.readFile(indexPath);
        res.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Type': MIME_TYPES['.html'],
        });
        res.end(headOnly ? undefined : data);
        return true;
      } catch (innerError) {
        sendText(res, 500, 'Unable to load the demo UI.');
        return true;
      }
    }

    return false;
  }
}

function extractCallId(locationHeader) {
  if (!locationHeader) {
    return null;
  }

  const match = locationHeader.match(/\/realtime\/calls\/([^/]+)/);
  return match ? match[1] : locationHeader;
}

function buildSessionConfig({ model, voice, instructions }) {
  return {
    type: 'realtime',
    model,
    instructions,
    audio: {
      input: {
        format: {
          type: 'audio/pcm',
          rate: 24000,
        },
        transcription: {
          model: 'whisper-1',
        },
        turn_detection: {
          type: 'server_vad',
        },
      },
      output: {
        format: {
          type: 'audio/pcm',
          rate: 24000,
        },
        voice,
      },
    },
    reasoning: {
      effort: 'low',
    },
  };
}

async function handleConfig(res) {
  sendJson(res, 200, {
    configured: Boolean(OPENAI_API_KEY),
    defaults: {
      instructions: DEFAULT_INSTRUCTIONS,
      model: DEFAULT_MODEL,
      voice: DEFAULT_VOICE,
    },
    host: HOST,
    port: PORT,
  });
}

async function handleRealtimeCall(req, res) {
  if (!OPENAI_API_KEY) {
    sendJson(res, 503, {
      error: 'OPENAI_API_KEY is not set on the server.',
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const sdp = typeof body.sdp === 'string' ? body.sdp.trim() : '';
  if (!sdp) {
    sendJson(res, 400, { error: 'Missing SDP offer in request body.' });
    return;
  }

  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;
  const voice = typeof body.voice === 'string' && body.voice.trim() ? body.voice.trim() : DEFAULT_VOICE;
  const instructions = typeof body.instructions === 'string' && body.instructions.trim()
    ? body.instructions.trim()
    : DEFAULT_INSTRUCTIONS;

  const session = buildSessionConfig({
    model,
    voice,
    instructions,
  });

  const form = new FormData();
  form.append('sdp', new Blob([sdp], { type: 'application/sdp' }), 'offer.sdp');
  form.append('session', new Blob([JSON.stringify(session)], { type: 'application/json' }), 'session.json');

  let upstream;
  try {
    upstream = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Safety-Identifier': SAFETY_IDENTIFIER,
      },
      body: form,
    });
  } catch (error) {
    sendJson(res, 502, {
      error: 'Failed to reach the OpenAI Realtime API.',
      detail: error.message,
    });
    return;
  }

  const responseText = await upstream.text();
  const location = upstream.headers.get('location');

  if (!upstream.ok) {
    sendJson(res, upstream.status, {
      error: 'OpenAI rejected the Realtime call request.',
      status: upstream.status,
      detail: responseText,
    });
    return;
  }

  sendJson(res, 200, {
    callId: extractCallId(location),
    location,
    sdp: responseText,
    session,
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'GET' && url.pathname === '/api/config') {
    await handleConfig(res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/realtime/call') {
    await handleRealtimeCall(req, res);
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const served = await serveStatic(url.pathname, res, req.method === 'HEAD');
    if (served) {
      return;
    }
  }

  sendText(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  Promise.resolve(handleRequest(req, res)).catch((error) => {
    console.error(error);
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: 'Internal server error.',
      });
      return;
    }

    res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Voice agent demo running at http://${HOST}:${PORT}`);
  if (!OPENAI_API_KEY) {
    console.log('OPENAI_API_KEY is not set. The UI will load, but connecting will fail until the key is configured.');
  }
});
