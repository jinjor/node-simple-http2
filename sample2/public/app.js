setTimeout(function() {
	var resourceList = window.performance.getEntriesByType("resource");
	var html = resourceList.map(function(resource) {
		return resource.name + ': ' + resource.duration + '<br>';
	}).join('');
	document.body.innerHTML = html;
}, 100);