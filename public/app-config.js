(function() {
  alert(window.location.hostname);
  alert("isBeta = " + window.location.hostname.toLowerCase().includes("beta"));
  
  const host = window.location.hostname.toLowerCase();
  
  const isBeta =
    host.includes("beta") ||
    host.includes("staging");
  
  window.APP_CONFIG = {
    title: isBeta ? "ACP Chat — Bêta" : "ACP Chat"
  };
})();