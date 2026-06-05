const AdmZip = require('adm-zip')
const fs = require('fs')
const path = require('path')

// Mirrors UPDATED cloud-data.ts: allowlist (Default + Local State), skip caches inside Default
const SKIP_DIRS = new Set(['Service Worker','blob_storage','Crashpad'])
function shouldSkipDir(name){ return name.includes('Cache') || SKIP_DIRS.has(name) }
function walk(zip, root, dir){
  for (const e of fs.readdirSync(dir,{withFileTypes:true})){
    const full = path.join(dir,e.name)
    if (e.isDirectory()){ if (shouldSkipDir(e.name)) continue; walk(zip,root,full) }
    else if (e.isFile()){ if (e.name.endsWith('.pma')) continue
      const relDir = path.relative(root,dir).split(path.sep).join('/')
      try { zip.addLocalFile(full, relDir, e.name) } catch {} }
  }
}
function buildZip(root){
  const zip = new AdmZip()
  const ls = path.join(root,'Local State'); if (fs.existsSync(ls)) try{zip.addLocalFile(ls,'','Local State')}catch{}
  const d = path.join(root,'Default'); if (fs.existsSync(d)) walk(zip,root,d)
  return zip.toBuffer()
}
const base = process.argv[2]
for (const p of fs.readdirSync(base,{withFileTypes:true})){
  if (!p.isDirectory()) continue
  const buf = buildZip(path.join(base,p.name))
  const mb = buf.length/1048576
  console.log((mb<50?'OK  ':'BIG ') + mb.toFixed(2) + ' MB  ' + p.name)
}
