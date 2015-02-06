var http2 = require('../index.js');
var fs = require('fs');
var Path = require('path');

var options = {
  key: fs.readFileSync('ssl/server.key'),
  cert: fs.readFileSync('ssl/server.crt'),
};

http2.createServer(options, function(req, res) {
  var method = req.method;
  var path = req.url;
  if (path === '/') {
    path = 'index.html';
  } else {
    path = path.substring(1);
  }
  if (path === 'index.html') {
    res.pushPromise('/app.css');
  }

  var contentType = 'text/plain';
  if (path.indexOf('.html') >= 0) {
    contentType = 'text/html';
  } else if (path.indexOf('.js') >= 0) {
    contentType = 'text/javascript';
  } else if (path.indexOf('.css') >= 0) {
    contentType = 'text/css';
  }
  var status = 200;
  var data = null;
  var filePath = Path.join('public', path);
  if (fs.existsSync(filePath)) {
    data = fs.readFileSync(filePath);
  } else {
    status = 404;
  }
  res.writeHead(status, {
    'content-type': contentType
  });
  res.end(data);
  
}).listen(8443);