var resourceList = window.performance.getEntriesByType("resource");
resourceList.forEach(function(resource) {
  document.write(resource.name + ': ' + resource.duration + '<br>');
});