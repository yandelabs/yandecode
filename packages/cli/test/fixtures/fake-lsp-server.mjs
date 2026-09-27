// Minimal LSP server for tests: speaks Content-Length framed JSON-RPC over stdio.
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};
const opened = new Map();
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const length = Number(
      /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1],
    );
    if (buffer.length < headerEnd + 4 + length) return;
    const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
    buffer = buffer.subarray(headerEnd + 4 + length);
    handle(message);
  }
});
function handle(m) {
  if (m.method === 'initialize') {
    // Ask the client something, like real servers do, before answering.
    send({ id: 900, method: 'workspace/configuration', params: { items: [{}] } });
    return send({
      id: m.id,
      result: { capabilities: { referencesProvider: true, definitionProvider: true } },
    });
  }
  if (m.method === 'textDocument/didOpen' || m.method === 'textDocument/didChange') {
    const uri = m.params.textDocument.uri;
    const text =
      m.method === 'textDocument/didOpen'
        ? m.params.textDocument.text
        : m.params.contentChanges[0].text;
    opened.set(uri, text);
    const line = text.split('\n').findIndex((l) => l.includes('BAD'));
    return send({
      method: 'textDocument/publishDiagnostics',
      params: {
        uri,
        diagnostics:
          line < 0
            ? []
            : [
                {
                  range: { start: { line, character: 0 }, end: { line, character: 3 } },
                  severity: 1,
                  message: 'BAD is not allowed',
                  source: 'fake',
                },
              ],
      },
    });
  }
  if (m.method === 'textDocument/references') {
    const uri = m.params.textDocument.uri;
    return send({
      id: m.id,
      result: [
        { uri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } } },
        { uri, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } } },
      ],
    });
  }
  if (m.method === 'textDocument/definition') {
    return send({
      id: m.id,
      result: {
        uri: m.params.textDocument.uri,
        range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
      },
    });
  }
  if (m.method === 'shutdown') return send({ id: m.id, result: null });
  if (m.method === 'exit') process.exit(0);
  if (m.id !== undefined && m.method) send({ id: m.id, result: null });
}
