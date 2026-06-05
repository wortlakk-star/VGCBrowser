const fs = require('fs')
const path = require('path')
const SKIP_DIRS = new Set([
  'optimization_guide_model_store','optimization_guide_prediction_model_downloads',
  'component_crx_cache','extensions_crx_cache','blob_storage','Crashpad','crash dumps',
  'BrowserMetrics','Service Worker','Safe Browsing','segmentation_platform',
  'Subresource Filter','SwReporter','GraphiteDawnCache'
])
function shouldSkipDir(name){ return name.includes('Cache') || SKIP_DIRS.has(name) }
const root = process.argv[2]
const included = []   // {rel, size}
function walk(dir){
  for (const e of fs.readdirSync(dir,{withFileTypes:true})){
    const full = path.join(dir,e.name)
    if (e.isDirectory()){ if (shouldSkipDir(e.name)) continue; walk(full) }
    else if (e.isFile()){
      if (e.name.endsWith('.pma')) continue
      let s=0; try{s=fs.statSync(full).size}catch{}
      included.push({rel: path.relative(root,full).split(path.sep).join('/'), size:s})
    }
  }
}
walk(root)
const total = included.reduce((a,b)=>a+b.size,0)
console.log('TOTAL included (uncompressed): ' + (total/1048576).toFixed(1) + ' MB, ' + included.length + ' files')
// group by top-2 path segments
const grp = {}
for (const f of included){ const k = f.rel.split('/').slice(0,2).join('/'); grp[k]=(grp[k]||0)+f.size }
console.log('Top included paths:')
Object.entries(grp).sort((a,b)=>b[1]-a[1]).slice(0,15).forEach(([k,v])=>{ if(v>200000) console.log('  '+(v/1048576).toFixed(1)+'MB  '+k) })
// biggest single files
console.log('Biggest single files:')
included.sort((a,b)=>b.size-a.size).slice(0,10).forEach(f=>{ if(f.size>500000) console.log('  '+(f.size/1048576).toFixed(1)+'MB  '+f.rel) })
