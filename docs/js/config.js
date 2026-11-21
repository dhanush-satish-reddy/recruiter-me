// Site settings. These values are public on purpose: nothing secret belongs here.
// The AI key lives only in the Cloudflare Worker.
window.RM_CONFIG = (() => {
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  return {
    // Address of the backend (Cloudflare Worker)
    API_URL: local ? "http://localhost:8787" : "https://recruiter-me.REPLACE-WITH-SUBDOMAIN.workers.dev",

    // Cloudflare Turnstile site key (public). The test key below always passes.
    TURNSTILE_SITE_KEY: local ? "1x00000000000000000000AA" : "REPLACE-WITH-TURNSTILE-SITE-KEY",
    SKIP_TURNSTILE: local,

    // Builder credit in the footer
    OWNER_NAME: "Dhanush Satish Reddy",
    OWNER_LINKEDIN: "https://www.linkedin.com/in/dhanushreddy05",
    OWNER_EMAIL: "REPLACE-WITH-EMAIL",
    OWNER_WEBSITE: "https://dhanush-satish-reddy.github.io",
    REPO_URL: "https://github.com/dhanush-satish-reddy/recruiter-me",

    LIMITS: { jobAd: 6000, answer: 1200 },
  };
})();
