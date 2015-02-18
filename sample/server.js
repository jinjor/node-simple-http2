var http2 = require('../index.js');
var fs = require('fs');
var Path = require('path');

var options = {
  key: fs.readFileSync('ssl/key.pem'),
  cert: fs.readFileSync('ssl/cert.pem')
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

  var filePath = Path.join('public', path);
  if (fs.existsSync(filePath)) {
    fs.readFile(filePath, function(e, data) {
      res.writeHead(200, {
        'content-type': contentType
      });
      res.end(data);
    });
  } else {
    res.writeHead(404, {
      'content-type': contentType
    });
    res.end();
  }
  
}).listen(8443);