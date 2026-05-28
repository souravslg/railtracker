(function(){
  var t=localStorage.getItem('tt');
  if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme:dark)').matches))
    document.documentElement.setAttribute('data-theme','dark');
})();
