var fs = require('fs');
var express = require('express');
var autopp = require('./index.js');

///
var app = express();
app.use(express.static(__dirname + '/public'));
app.listen(3000);
///

var options = {
  key: fs.readFileSync('ssl/key.pem'),
  cert: fs.readFileSync('ssl/cert.pem')
};

autopp(options, 8443, 3000);