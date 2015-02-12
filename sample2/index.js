var http2 = require('../index.js');
var Path = require('path');
var htmlparser2 = require('htmlparser2');
var request = require('request');


var parse = function(html, onScript, onStyle) {
  var parser = new htmlparser2.Parser({
    onopentag: function(name, attribs) {
      if (name === "script") {
        onScript(attribs.src);
      } else if (name === "link" && attribs.rel === "stylesheet") {
        onStyle(attribs.href);
      }
    }
  });
  parser.write(html);
  parser.end();
};

module.exports = function(options, fromPort, toPort) {

  http2.createServer(options, function(req, res) {
    var method = req.method;
    var path = req.url;
    request('http://localhost:' + toPort + path, function(error, response, body) {
      if (error) {
        console.log(path, error)
        res.writeHead(500, {});
        res.end();
      } else {
        if (response.headers['content-type'].indexOf('html') >= 0) {
          parse(body, function(src) {
            res.pushPromise(src);
          }, function(href) {
            res.pushPromise(href);
          });
        }
        res.writeHead(response.statusCode, {
          'content-type': response.headers['content-type'].split(';')[0]
        });
        res.end(new Buffer(body));
      }
    });
  }).listen(fromPort);

};