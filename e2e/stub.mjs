import fs from 'node:fs';
import http from 'node:http';

const port = Number(process.env['PORT'] || 8899);
const capture = process.env['CAPTURE'] || '/tmp/ah-capture.ndjson';
const script = (process.env['TOOL_SCRIPT'] || 'tool-then-text').trim();

let modelCalls = 0;

function decode(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const hintHeader = req.headers['x-agent-hint'];
    const entry = {
      method: req.method,
      url: req.url,
      hint_header_present: typeof hintHeader === 'string',
      hint: decode(hintHeader),
      has_api_key: typeof req.headers['x-goog-api-key'] === 'string',
      body_bytes: body.length,
      body_prefix: body.slice(0, 600),
    };
    fs.appendFileSync(capture, `${JSON.stringify(entry)}\n`);

    const stream = (req.url || '').includes('streamGenerateContent');
    if (!stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }

    modelCalls += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });

    if (script === 'tool-then-text' && modelCalls === 1) {
      sse(res, {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'run_shell_command',
                    args: {
                      command: 'echo hi',
                      description: 'print hi',
                      is_background: false,
                    },
                  },
                },
              ],
            },
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 4,
          totalTokenCount: 16,
        },
      });
      res.end();
      return;
    }

    sse(res, {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'done' }] },
          index: 0,
        },
      ],
    });
    sse(res, {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: '' }] },
          finishReason: 'STOP',
          index: 0,
        },
      ],
      usageMetadata: {
        promptTokenCount: 20,
        candidatesTokenCount: 1,
        totalTokenCount: 21,
      },
    });
    res.end();
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`stub listening on ${port}`);
});
