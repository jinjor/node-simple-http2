setTimeout(function() {
	var resourceList = window.performance.getEntriesByType("resource");
	var html = resourceList.map(function(resource) {
		return resource.name + ': ' + resource.duration + '<br>';
	}).join('');
	document.body.innerHTML = html;
}, 500);



var xhr = new XMLHttpRequest();
xhr.open('GET', 'sample.json', true);
xhr.responseType = 'application/json';
xhr.onload = function(e) {
  console.log(this.response);
};
xhr.send();