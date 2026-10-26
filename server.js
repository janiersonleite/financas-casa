const http = require('http');
const fs   = require('fs');
const path = require('path');
// Servidor de DESENVOLVIMENTO (npm start). PORT=0 escolhe uma porta livre (usado nos testes).
const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 3000;
const HOST = '127.0.0.1';          // só a própria máquina (não expõe na rede)
const ROOT = path.resolve(__dirname);

const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff2':'font/woff2',
    '.woff': 'font/woff',
};

const server = http.createServer((req, res) => {
    const notFound = () => { res.writeHead(404); res.end('404 Not Found'); };
    let urlPath;
    try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch { return notFound(); }
    if (urlPath.includes('\0')) return notFound();
    if (urlPath === '/') urlPath = '/index.html';

    // resolve o caminho e exige que continue DENTRO da pasta do projeto (bloqueia "/../" e %2e%2e)
    const filePath = path.resolve(ROOT, '.' + path.normalize('/' + urlPath));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) return notFound();
    // ignora arquivos/pastas ocultos (.git, .env, .claude...) e node_modules
    const rel = path.relative(ROOT, filePath).split(path.sep);
    if (rel.some(seg => seg.startsWith('.') || seg === 'node_modules')) return notFound();

    fs.readFile(filePath, (err, data) => {
        if (err) return notFound();
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

server.listen(PORT, HOST, () => {
    console.log(`\n✅ Servidor rodando em http://localhost:${server.address().port}\n`);
    console.log('   Pressione Ctrl+C para parar.\n');
});
