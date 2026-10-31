import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
async function check(directory){for(const e of await readdir(new URL(directory+'/',new URL('../',import.meta.url)),{withFileTypes:true})){if(e.name.startsWith('.'))continue;const p=directory+'/'+e.name;if(e.isDirectory())await check(p);else if(/\.[cm]?js$/.test(e.name)){const r=spawnSync(process.execPath,['--check',p],{cwd:root,stdio:'inherit'});if(r.status)process.exit(r.status);}}}
for(const p of ['public','server','api','scripts','tests'])await check(p);
console.log('Observatory modules parse.');
