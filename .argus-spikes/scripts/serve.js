const http = require('http');
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const server = http.createServer((req,res)=>{
  let f = req.url.split('?')[0];
  if (f === '/') f = '/spike-d.html';
  const p = path.join(dir, f);
  fs.readFile(p, (err,data)=>{
    if (err){ res.writeHead(404); res.end('nf'); return; }
    const ext = path.extname(p);
    const ct = ext==='.html'?'text/html':'text/plain';
    res.writeHead(200, {'content-type':ct});
    res.end(data);
  });
});
server.listen(8791, '127.0.0.1', ()=>console.log('listening 8791'));
