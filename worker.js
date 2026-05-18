// ================================================================
//  CLOUDFLARE WORKER  —  Proxy Backend  (v2)
//  Deploy: dash.cloudflare.com → Workers & Pages → Create Worker
//
//  SECRETS — set in Worker dashboard → Settings → Variables:
//    GEMINI_API_KEY   your Gemini API key  (Smart Mode only, optional)
//    ALLOWED_ORIGIN   your GitHub Pages URL e.g. https://you.github.io
//                     (leave blank during testing to allow all origins)
// ================================================================

// ── User-agent presets — tried in order until one succeeds ──────
const UA_PRESETS = [
  {
    label: 'Chrome 124 / Windows',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
    },
  },
  {
    label: 'Firefox 125 / Windows',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
    },
  },
  {
    label: 'Mobile Safari / iOS 17',
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  },
  {
    label: 'Googlebot',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Accept': 'text/html',
      'Accept-Language': 'en',
    },
  },
]

// ── Entry point ─────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return corsResp('', 204, env)
    }

    const reqUrl = new URL(request.url)

    // Health check — frontend pings this to confirm worker is live
    if (reqUrl.pathname === '/ping') {
      return corsResp(JSON.stringify({ ok: true, ts: Date.now() }), 200, env, 'application/json')
    }

    // Smart routing decision — ?route=<url>
    // Returns { proxy: true|false, reason: "..." }
    if (reqUrl.pathname === '/route') {
      return handleRouteDecision(reqUrl, env)
    }

    // Main proxy — ?url=<target>
    const target = reqUrl.searchParams.get('url')
    if (!target) {
      return corsResp(
        JSON.stringify({ error: 'no_url', message: 'Pass ?url=https://example.com' }),
        400, env, 'application/json'
      )
    }

    return proxyTarget(target, reqUrl, env)
  },
}

// ── Core proxy logic ────────────────────────────────────────────
async function proxyTarget(rawUrl, reqUrl, env) {
  let targetUrl = rawUrl.trim()
  if (!targetUrl.match(/^https?:\/\//i)) targetUrl = 'https://' + targetUrl

  let lastError = null

  for (const preset of UA_PRESETS) {
    try {
      const upstream = await fetch(targetUrl, {
        headers: preset.headers,
        redirect: 'follow',
        cf: { cacheTtl: 0, scrapeShield: false },
      })

      const ct = upstream.headers.get('content-type') || ''

      // HTML — inject link-intercept script + rewrite asset URLs
      if (ct.includes('text/html')) {
        let html = await upstream.text()
        html = rewriteHtml(html, targetUrl, reqUrl)
        return corsResp(html, upstream.status, env, 'text/html; charset=utf-8')
      }

      // CSS — rewrite url() references so assets still load through proxy
      if (ct.includes('text/css')) {
        let css = await upstream.text()
        css = rewriteCssUrls(css, targetUrl, reqUrl)
        return corsResp(css, upstream.status, env, ct)
      }

      // Everything else (images, fonts, JS, JSON) — pass straight through
      return new Response(await upstream.arrayBuffer(), {
        status: upstream.status,
        headers: {
          'Content-Type': ct || 'application/octet-stream',
          'Cache-Control': 'no-store',
          ...corsHeaders(env),
        },
      })

    } catch (err) {
      lastError = err
      // Continue to next UA preset
    }
  }

  return corsResp(
    JSON.stringify({
      error: 'fetch_failed',
      message: lastError?.message ?? 'All connection attempts failed.',
      tried: UA_PRESETS.length,
      url: targetUrl,
    }),
    502, env, 'application/json'
  )
}

// ── Smart routing decision ──────────────────────────────────────
// Uses Gemini if key is set; otherwise falls back to heuristic.
async function handleRouteDecision(reqUrl, env) {
  const url = reqUrl.searchParams.get('url') || ''

  if (!env.GEMINI_API_KEY) {
    return corsResp(JSON.stringify(heuristicRoute(url)), 200, env, 'application/json')
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text:
                `You are a network routing assistant. Decide if a URL should be proxied (true) or loaded directly (false).
Proxy = true  → social media, gaming, streaming, news aggregators, forums, anything commonly blocked by school filters.
Proxy = false → google.com, youtube.com, wikipedia.org, github.com, educational tools, well-known productivity sites.
URL: ${url}
Reply ONLY with valid JSON (no markdown): {"proxy": true, "reason": "one short sentence"}`
            }]
          }],
          generationConfig: { maxOutputTokens: 60, temperature: 0 },
        }),
      }
    )
    const data = await res.json()
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
    return corsResp(JSON.stringify(JSON.parse(text)), 200, env, 'application/json')
  } catch {
    return corsResp(JSON.stringify(heuristicRoute(url)), 200, env, 'application/json')
  }
}

function heuristicRoute(url) {
  try {
    const host = new URL(url.startsWith('http') ? url : 'https://' + url)
      .hostname.replace(/^www\./, '')
    const alwaysDirect = [
      'google.com','google.co.nz','youtube.com','wikipedia.org',
      'github.com','stackoverflow.com','khanacademy.org',
      'docs.google.com','drive.google.com','classroom.google.com',
      'bing.com','search.yahoo.com',
    ]
    if (alwaysDirect.some(d => host === d || host.endsWith('.' + d))) {
      return { proxy: false, reason: 'Recognised allowed domain — loading directly.' }
    }
    return { proxy: true, reason: 'Unknown or likely-blocked domain — routing via proxy.' }
  } catch {
    return { proxy: true, reason: 'Could not parse URL — defaulting to proxy.' }
  }
}

// ── HTML rewriting ──────────────────────────────────────────────
function rewriteHtml(html, pageUrl, reqUrl) {
  const proxyBase = reqUrl.origin + reqUrl.pathname
  const script = buildInterceptScript(pageUrl, proxyBase)
  if (html.includes('</head>')) return html.replace('</head>', script + '\n</head>')
  if (html.includes('</body>')) return html.replace('</body>', script + '\n</body>')
  return script + html
}

function buildInterceptScript(pageUrl, proxyBase) {
  const safePageUrl = pageUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const safeProxyBase = proxyBase.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return `<script>
(function(){
  var PAGE='${safePageUrl}';
  var PROXY='${safeProxyBase}';
  function toProxy(href){
    if(!href) return href;
    var s=href.trim();
    if(/^(data:|javascript:|#|blob:|mailto:|tel:)/.test(s)) return s;
    try{ return PROXY+'?url='+encodeURIComponent(new URL(s,PAGE).href); }
    catch(e){ return href; }
  }
  document.addEventListener('click',function(e){
    var a=e.target.closest('a[href]');
    if(!a) return;
    var h=a.getAttribute('href');
    if(!h||h.startsWith('#')) return;
    e.preventDefault(); e.stopPropagation();
    try{ window.top.postMessage({t:'nav',u:new URL(h,PAGE).href},'*'); }catch(_){}
  },true);
  document.addEventListener('submit',function(e){
    e.preventDefault();
    var f=e.target;
    var qs=new URLSearchParams(new FormData(f)).toString();
    var action=f.getAttribute('action')||PAGE;
    var u=f.method.toLowerCase()==='get'?(action.split('?')[0]+'?'+qs):action;
    try{ window.top.postMessage({t:'nav',u:new URL(u,PAGE).href},'*'); }catch(_){}
  },true);
  function rewriteStatic(){
    document.querySelectorAll('img[src],source[src],video[src],audio[src],link[href]').forEach(function(el){
      var attr=el.hasAttribute('src')?'src':'href';
      var val=el.getAttribute(attr);
      if(val&&!/^(data:|blob:|javascript:|#)/.test(val)){
        try{ el.setAttribute(attr,toProxy(val)); }catch(_){}
      }
    });
  }
  document.readyState==='loading'
    ? document.addEventListener('DOMContentLoaded',rewriteStatic)
    : rewriteStatic();
})();
<\/script>`
}

function rewriteCssUrls(css, baseUrl, reqUrl) {
  const proxyBase = reqUrl.origin + reqUrl.pathname
  return css.replace(/url\(['"]?([^'"\)]+)['"]?\)/gi, (match, u) => {
    try {
      const abs = new URL(u, baseUrl).href
      return `url('${proxyBase}?url=${encodeURIComponent(abs)}')`
    } catch { return match }
  })
}

// ── CORS helpers ────────────────────────────────────────────────
function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env?.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
  }
}

function corsResp(body, status, env, ct = 'application/json') {
  return new Response(body, {
    status,
    headers: { 'Content-Type': ct, 'Cache-Control': 'no-store', ...corsHeaders(env) },
  })
}
