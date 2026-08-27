const BASE="https://3asq.online";

function abs(u){
  if(!u)return undefined;
  try{
    const x=new URL(String(u).trim(),BASE);
    return /^https?:$/i.test(x.protocol)?x.href:undefined;
  }catch{return undefined}
}

function path(u){
  try{
    const x=new URL(String(u).trim(),BASE);
    return x.pathname.replace(/^\/+|\/+$/g,"")+(x.search||"");
  }catch{return ""}
}

async function doc(p){
  const r=await harbor.http(BASE+p,{responseType:"text"});
  return r.ok?harbor.parseHtml(r.body):null;
}

async function raw(p){
  const r=await harbor.http(BASE+p,{responseType:"text"});
  return r.ok?(r.body||""):"";
}

function text(r,s){
  for(const x of s){
    const e=r.querySelector(x);
    const t=e?(e.text()||"").trim():"";
    if(t)return t;
  }
  return "";
}

function meta(d,n){
  const w=n.map(x=>x.toLowerCase());
  for(const m of d.querySelectorAll("meta")){
    const k=((m.attr("property")||m.attr("name")||"")+"").toLowerCase();
    if(w.includes(k))return(m.attr("content")||"").trim();
  }
  return "";
}

function img(i){
  if(!i)return undefined;
  return abs(
    i.attr("data-src")||
    i.attr("data-lazy-src")||
    i.attr("data-original")||
    i.attr("data-lazy")||
    i.attr("data-cfsrc")||
    i.attr("src")
  );
}

function cover(d){
  const m=meta(d,["og:image","twitter:image","twitter:image:src"]);
  if(m)return abs(m);
  for(const s of [
    ".summary_image img",
    ".summary-image img",
    ".post-thumbnail img",
    ".tab-summary .summary_image img"
  ]){
    const u=img(d.querySelector(s));
    if(u)return u;
  }
}

function isChapterLink(h){
  return /\/manga\/[^/]+\/\d+(?:\.\d+)?\/?(?:\?.*)?$/i.test(h)||
         /chapter[\s._-]*\d+/i.test(h);
}

function chapterNumber(t,h){
  const s=`${t||""} ${h||""}`;
  for(const r of [
    /chapter[\s._-]*(\d+(?:\.\d+)?)/i,
    /\bch[\s._-]*(\d+(?:\.\d+)?)/i,
    /\/([0-9]+(?:\.[0-9]+)?)\/?(?:\?.*)?$/
  ]){
    const m=s.match(r);
    if(m)return m[1];
  }
  return null;
}

function parseChapterDocument(d){
  const out=[];
  const seen=new Set();
  for(const a of d.querySelectorAll("li.wp-manga-chapter a, .wp-manga-chapter a, .wp-manga-chapters a, .chapter-list a, .version-chap a, .listing-chapters_wrap a, .chapter-item a")){
    const h=a.attr("href")||"";
    if(!h)continue;
    const id=path(h);
    const t=(a.text()||a.attr("title")||"").trim();
    const n=chapterNumber(t,h);
    if(!id||!n||seen.has(id)||!isChapterLink(h))continue;
    const li=a.closest? a.closest("li.wp-manga-chapter"):null;
    const time=li&&li.querySelector?li.querySelector(".chapter-release-date, time"):null;
    const published=time?((time.attr("datetime")||time.text()||"").trim()||undefined):undefined;
    seen.add(id);
    out.push({
      id,
      chapter:n,
      title:t||`الفصل ${n}`,
      volume:null,
      pages:0,
      language:"en",
      publishAt:published
    });
  }
  out.sort((a,b)=>parseFloat(b.chapter)-parseFloat(a.chapter));
  return out;
}

function parseChapterHtmlString(html){
  if(!html)return [];
  try{return parseChapterDocument(harbor.parseHtml(html));}
  catch{return []}
}

function findMangaId(d){
  for(const s of [
    "#manga-chapters-holder",
    "[id^=manga-chapters-holder]",
    ".c-tabs-item__content [data-id]",
    "[data-manga-id]"
  ]){
    const e=d.querySelector(s);
    if(!e)continue;
    const v=e.attr("data-id")||e.attr("data-manga-id");
    if(v)return String(v).trim();
  }

  const script=d.querySelector("script#wp-manga-js-extra");
  if(script){
    const s=script.text()||"";
    const m=s.match(/(?:manga_id|mangaId)["']?\s*[:=]\s*["']?(\d+)/i);
    if(m)return m[1];
  }

  return null;
}

function encodeForm(obj){
  return Object.keys(obj).map(k=>encodeURIComponent(k)+"="+encodeURIComponent(obj[k]??"")).join("&");
}

async function postText(url,body){
  try{
    const r=await harbor.http(url,{
      method:"POST",
      headers:{
        "Content-Type":"application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With":"XMLHttpRequest",
        "Referer":BASE+"/"
      },
      body,
      responseType:"text"
    });
    return r.ok?(r.body||""):"";
  }catch{return ""}
}

async function fetchAllChapters(mangaId,mangaPath){
  // Madara old chapter endpoint.
  if(mangaId){
    const body=encodeForm({action:"manga_get_chapters",manga:mangaId});
    const html=await postText(BASE+"/wp-admin/admin-ajax.php",body);
    const parsed=parseChapterHtmlString(html);
    if(parsed.length)return parsed;

    // Some hosts accept the same action as GET.
    const getHtml=await raw("/wp-admin/admin-ajax.php?"+body);
    const getParsed=parseChapterHtmlString(getHtml);
    if(getParsed.length)return getParsed;
  }

  // Madara newer chapter endpoint.
  const clean=String(mangaPath||"").replace(/^\/+|\/+$/g,"");
  if(clean){
    const html=await postText(BASE+"/"+clean+"/ajax/chapters","");
    const parsed=parseChapterHtmlString(html);
    if(parsed.length)return parsed;
  }

  return [];
}

function summaries(d){
  const o=[],seen=new Set();
  for(const s of [".page-item-detail",".bsx",".manga-item","article"]){
    for(const c of d.querySelectorAll(s)){
      let a=null;
      for(const x of c.querySelectorAll("a")){
        const h=x.attr("href")||"";
        if(/\/manga\//i.test(h)&&!isChapterLink(h)){a=x;break}
      }
      if(!a)continue;
      const id=path(a.attr("href")||"");
      const title=(a.attr("title")||a.text()||text(c,["h2","h3",".title"])||"").trim();
      if(id&&title&&!seen.has(id)){
        seen.add(id);
        o.push({id,title,cover:img(c.querySelector("img")||a.querySelector("img"))});
      }
    }
  }
  return o;
}

function paths(kind,p,q,t){
  const e=encodeURIComponent(q||""),g=t?encodeURIComponent(t):"";
  if(kind==="popular")return g?
    [`/manga-genre/${g}/?m_orderby=views&page=${p}`,`/genre/${g}/?m_orderby=views&page=${p}`]:
    [`/manga/?m_orderby=views&page=${p}`,`/manga/page/${p}/?m_orderby=views`];
  return g?
    [`/manga-genre/${g}/?s=${e}&post_type=wp-manga&page=${p}`,`/genre/${g}/?s=${e}&post_type=wp-manga&page=${p}`]:
    [`/manga/?s=${e}&post_type=wp-manga&page=${p}`,`/?s=${e}&post_type=wp-manga&page=${p}`];
}

async function pageUrls(id){
  const p=String(id).replace(/^\/+/,"");
  const d=await doc("/"+p);
  const o=[],seen=new Set();
  if(d){
    for(const s of [
      ".reading-content img",
      "#readerarea img",
      ".page-break img",
      ".entry-content .page-break img",
      ".wp-manga-chapter-img img",
      ".manga-chapter img"
    ]){
      for(const i of d.querySelectorAll(s)){
        const u=img(i);
        if(u&&!seen.has(u)){seen.add(u);o.push(u)}
      }
    }
  }
  return o;
}

const plugin={
  id:"3asq-online",
  name:"3asq.online",

  async popular(offset,tagId){
    for(const p of paths("popular",Math.floor(offset/48)+1,"",tagId)){
      const d=await doc(p),x=d&&summaries(d);
      if(x&&x.length)return x;
    }
    return [];
  },

  async search(q,offset,tagId){
    for(const p of paths("search",Math.floor(offset/48)+1,q,tagId)){
      const d=await doc(p),x=d&&summaries(d);
      if(x&&x.length)return x;
    }
    return [];
  },

  async detail(id){
    const clean=String(id).replace(/^\/+/,"");
    const d=await doc("/"+clean);
    if(!d)return null;
    const y=text(d,[".year",".release-year",".summary-content.year"]).match(/\b(19\d{2}|20\d{2})\b/);
    const holder=d.querySelector("#manga-chapters-holder,[id^=manga-chapters-holder]");
    const chapterCount=text(d,[".summary-content.chapter-count",".post-content_item.manga-chapters .summary-content"]);
    const first=text(d,[".wp-manga-chapter a",".chapter-list a"]);
    return {
      id,
      title:text(d,[".post-title h1",".summary-title h1","h1.entry-title","h1"])||meta(d,["og:title"])||id,
      altTitle:text(d,[".alternative",".alt-title"])||undefined,
      cover:cover(d),
      year:y?Number(y[1]):undefined,
      status:text(d,[".post-status .summary-content",".summary-content.status"])||undefined,
      description:meta(d,["og:description","description"])||text(d,[".summary__content",".summary_content",".summary-content",".description-summary"]),
      lastChapter:first||chapterCount||undefined,
      author:text(d,[".author-content",".author",".summary-content.author"])||undefined
    };
  },

  async chapters(id){
    const clean=String(id).replace(/^\/+/,"");
    const d=await doc("/"+clean);
    if(!d)return [];

    const mangaId=findMangaId(d);
    const all=await fetchAllChapters(mangaId,clean);
    if(all.length)return all;

    // Keep the normal HTML parser as a final fallback.
    return parseChapterDocument(d);
  },

  async pageUrls(id){return pageUrls(id)},

  async tags(){
    const o=[],seen=new Set();
    for(const p of ["/manga-genre/","/genre/","/genres/","/"]){
      const d=await doc(p);
      if(!d)continue;
      for(const a of d.querySelectorAll('a[href*="/manga-genre/"],a[href*="/genre/"],a[href*="/genres/"]')){
        const id=path(a.attr("href")||"").replace(/^(manga-genre|genre|genres)\//i,"").replace(/^\/+|\/+$/g,"");
        const name=(a.text()||"").trim();
        if(id&&name&&!seen.has(id)){seen.add(id);o.push({id,name,group:"Genre"})}
      }
    }
    return o;
  }
};

harbor.register(plugin);
