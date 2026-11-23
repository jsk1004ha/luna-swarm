import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXECUTOR_SOURCE = String.raw`
import { chmod, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
const fail=(error)=>process.stdout.write(JSON.stringify({outcome:"failed",error:String(error)})+"\n");
try {
  const message=JSON.parse(Buffer.concat(chunks).toString("utf8").trimEnd());
  const manifest=message?.workOrder?.implementationManifest;
  if (manifest?.schemaVersion!==1 || manifest.baseCommit!==message.workOrder.baseCommit || !Array.isArray(manifest.changes)) throw new Error("bound implementation manifest missing");
  const root=resolve(process.cwd());
  if(await realpath(root)!==root) throw new Error("clone root is aliased");
  const safe=(path)=>{
    if(typeof path!=="string" || path.includes("\\") || path.startsWith("/") || path.split("/").some((part)=>!part || part==="." || part==="..")) throw new Error("unsafe manifest path");
    const target=resolve(root,...path.split("/"));
    if(target!==root && !target.startsWith(root+sep)) throw new Error("manifest path escaped clone");
    return target;
  };
  const inspect=async(path,operation)=>{
    const segments=path.split("/");
    let cursor=root;
    for(let index=0;index<segments.length;index+=1){
      cursor=resolve(cursor,segments[index]);
      const leaf=index===segments.length-1;
      try {
        const info=await lstat(cursor);
        if(info.isSymbolicLink()) throw new Error("manifest path contains a symlink or junction");
        if(!leaf && !info.isDirectory()) throw new Error("manifest parent is not a directory");
        if(leaf && (!info.isFile() || info.nlink!==1)) throw new Error("manifest leaf is not a single-link regular file");
      } catch(error) {
        if(error?.code!=="ENOENT") throw error;
        if(!leaf && operation==="upsert") {
          await mkdir(cursor);
          const created=await lstat(cursor);
          if(created.isSymbolicLink() || !created.isDirectory()) throw new Error("manifest parent creation was redirected");
        } else if(!leaf) return false;
      }
    }
    return true;
  };
  for(const change of manifest.changes){
    const target=safe(change.path);
    const reachable=await inspect(change.path,change.operation);
    if(change.operation==="delete") { if(reachable) await rm(target,{force:true}); }
    else if(change.operation==="upsert" && typeof change.contentUtf8==="string"){
      await writeFile(target,change.contentUtf8,{encoding:"utf8",flag:"w",mode:change.mode==="100755"?0o755:0o644});
      await chmod(target,change.mode==="100755"?0o755:0o644);
    } else throw new Error("invalid manifest operation");
  }
  process.stdout.write(JSON.stringify({outcome:"completed"})+"\n");
} catch(error) { fail(error?.message??error); }
`;

const CHECK_SOURCE = String.raw`
import { run } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
const denyNetwork=()=>{ throw new Error("protected check network access is disabled"); };
for(const [target,names] of [
  [net,["connect","createConnection","createServer"]],
  [tls,["connect","createServer"]],
  [http,["request","get","createServer"]],
  [https,["request","get","createServer"]],
  [http2,["connect","createServer","createSecureServer"]],
  [dgram,["createSocket"]],
  [dns,["lookup","resolve","resolve4","resolve6","reverse"]],
  [dnsPromises,["lookup","resolve","resolve4","resolve6","reverse"]],
]) for(const name of names) {
  try { Object.defineProperty(target,name,{value:denyNetwork,writable:false,configurable:false}); }
  catch { try { target[name]=denyNetwork; } catch {} }
}
syncBuiltinESMExports();
for(const name of ["fetch","WebSocket","EventSource"]) {
  try { Object.defineProperty(globalThis,name,{value:denyNetwork,writable:false,configurable:false}); } catch {}
}
const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
try {
  const message=JSON.parse(Buffer.concat(chunks).toString("utf8").trimEnd());
  if(!Array.isArray(message.args) || message.args.length===0) throw new Error("unsupported protected check");
  for(const path of message.args) if(typeof path!=="string" || path.includes("\\") || path.startsWith("/") || path.split("/").some((part)=>!part || part==="." || part==="..")) throw new Error("unsafe test path");
  if(message.program==="node:test") {
    let failures=0, tests=0;
    const stream=run({files:message.args,isolation:"none",concurrency:1});
    for await (const event of stream) {
      if(event.type==="test:pass") tests+=1;
      if(event.type==="test:fail") { tests+=1; failures+=1; }
    }
    process.stdout.write(JSON.stringify({exitCode:failures===0?0:1,stdout:JSON.stringify({tests,failures}),stderr:""})+"\n");
  } else if(message.program==="luna:typescript-syntax") {
    const ts=createRequire(import.meta.url)("./typescript.cjs");
    const root=resolve(process.cwd());
    let files=0, bytes=0, failures=0;
    const diagnostics=[];
    for(const configName of message.args) {
      const configPath=resolve(root,...configName.split("/"));
      if(configPath!==root && !configPath.startsWith(root+sep)) throw new Error("typescript config escaped clone");
      const loaded=ts.readConfigFile(configPath,ts.sys.readFile);
      if(loaded.error) diagnostics.push(loaded.error);
      else {
        const parsed=ts.parseJsonConfigFileContent(loaded.config,ts.sys,dirname(configPath),{noEmit:true},configPath);
        diagnostics.push(...parsed.errors);
        for(const fileName of parsed.fileNames) {
          const absolute=resolve(fileName);
          if(absolute!==root && !absolute.startsWith(root+sep)) continue;
          if(!/\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/iu.test(absolute) || /\.d\.[cm]?ts$/iu.test(absolute)) continue;
          const source=ts.sys.readFile(absolute);
          if(typeof source!=="string") { failures+=1; continue; }
          files+=1; bytes+=Buffer.byteLength(source);
          if(files>10000 || bytes>64*1024*1024) throw new Error("typescript syntax check budget exceeded");
          const result=ts.transpileModule(source,{fileName:absolute,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}});
          diagnostics.push(...(result.diagnostics??[]));
        }
      }
    }
    failures+=diagnostics.filter((diagnostic)=>diagnostic.category===ts.DiagnosticCategory.Error).length;
    process.stdout.write(JSON.stringify({exitCode:failures===0&&files>0?0:1,stdout:JSON.stringify({files,failures}),stderr:""})+"\n");
  } else throw new Error("unsupported protected check");
} catch(error) {
  process.stdout.write(JSON.stringify({exitCode:1,stdout:"",stderr:String(error?.message??error)})+"\n");
}
`;

const AUDIT_SOURCE = String.raw`
const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
const equal=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const sameFile=(left,right)=>left?.path===right?.path && left?.operation===right?.operation && left?.mode===right?.mode && left?.contentBase64===right?.contentBase64;
try {
  const message=JSON.parse(Buffer.concat(chunks).toString("utf8").trimEnd());
  const request=message.request;
  const manifest=request?.implementationManifest;
  const binding=request?.sourceBinding;
  let reason="";
  if(!binding || typeof binding.runId!=="string" || typeof binding.taskId!=="string" || typeof binding.assignedAgentId!=="string" || !binding.sourceArtifact || !Array.isArray(binding.verificationArtifacts)) reason="source binding missing";
  else if(manifest?.schemaVersion!==1 || manifest.baseCommit!==request.baseCommit || !Array.isArray(manifest.changes)) reason="manifest binding missing";
  else {
    const expected=manifest.changes.map((change)=>change.operation==="delete"
      ? {path:change.path,operation:"delete",mode:change.mode}
      : {path:change.path,operation:"upsert",mode:change.mode,contentBase64:Buffer.from(change.contentUtf8,"utf8").toString("base64")});
    if(expected.length!==request.files.length || expected.some((file,index)=>!sameFile(file,request.files[index]))) reason="snapshot does not exactly match reviewed implementation manifest";
    else if(!equal(expected.map((file)=>file.path),request.changedPaths)) reason="changed path binding mismatch";
  }
  process.stdout.write(JSON.stringify({outcome:reason?"fail":"pass",evidence:reason?{reason}:{workOrderHash:request.workOrderHash,sourceArtifact:binding.sourceArtifact,verificationArtifacts:binding.verificationArtifacts,manifestHash:request.manifestHash}})+"\n");
} catch(error) {
  process.stdout.write(JSON.stringify({outcome:"fail",evidence:{reason:String(error?.message??error)}})+"\n");
}
`;

export interface SwarmRuntimeAssets {
  root: string;
  executablePath: string;
  executableSha256: string;
  executorEntryPath: string;
  executorEntrySha256: string;
  checkEntryPath: string;
  checkEntrySha256: string;
  auditEntryPath: string;
  auditEntrySha256: string;
  typescriptEntryPath: string;
  typescriptEntrySha256: string;
  cleanup(): Promise<void>;
}

export async function materializeSwarmRuntimeAssets(): Promise<Readonly<SwarmRuntimeAssets>> {
  const root = await mkdtemp(join(tmpdir(), "luna-swarm-coding-assets-"));
  const executorEntryPath = join(root, "manifest-executor.mjs");
  const checkEntryPath = join(root, "node-test-check.mjs");
  const auditEntryPath = join(root, "manifest-audit.mjs");
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(executorEntryPath, EXECUTOR_SOURCE, { encoding: "utf8", flag: "wx", mode: 0o400 }),
    writeFile(checkEntryPath, CHECK_SOURCE, { encoding: "utf8", flag: "wx", mode: 0o400 }),
    writeFile(auditEntryPath, AUDIT_SOURCE, { encoding: "utf8", flag: "wx", mode: 0o400 }),
  ]);
  const executablePath = process.execPath;
  const typescriptEntryPath = createRequire(import.meta.url).resolve("typescript");
  return Object.freeze({
    root,
    executablePath,
    executableSha256: await hashFile(executablePath),
    executorEntryPath,
    executorEntrySha256: await hashFile(executorEntryPath),
    checkEntryPath,
    checkEntrySha256: await hashFile(checkEntryPath),
    auditEntryPath,
    auditEntrySha256: await hashFile(auditEntryPath),
    typescriptEntryPath,
    typescriptEntrySha256: await hashFile(typescriptEntryPath),
    cleanup: () => rm(root, { recursive: true, force: true }),
  });
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
