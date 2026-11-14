#!/usr/bin/env node
/**
 * Read-only Hostinger runtime provenance attestation.
 *
 * Run from the ACTUAL deployed BizPortal application directory on Hostinger,
 * not a GitHub Actions checkout, a developer computer, or the unrelated VPS.
 * This script does not modify files, query databases, inspect environment
 * variables, print credentials, restart services, or use network access.
 *
 * This script can prove a local filesystem/build fingerprint. It cannot
 * independently prove a running process serves that directory; verify
 * process working directory and deployment history separately.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root=realpathSync(resolve(process.cwd()));
const git=(...args)=>{
  try{
    return execFileSync("git",args,{
      cwd:root,encoding:"utf8",timeout:3000,
      stdio:["ignore","pipe","ignore"],
    }).trim();
  }catch{return null;}
};
const sha256=(relative)=>{
  const file=resolve(root,relative);
  if(!existsSync(file)) return null;
  try {
    if(!statSync(file).isFile()) return null;
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  }catch{return null;}
};
const head=git("rev-parse","--verify","HEAD");
const branch=git("symbolic-ref","--quiet","--short","HEAD");
const top=git("rev-parse","--show-toplevel");
const remote=git("config","--get","remote.origin.url");
// Do not emit raw remote URLs: they may embed usernames or access tokens.
let remoteHost=null;
if(remote){
  const match=remote.match(/^(?:https?:\/\/|ssh:\/\/|git@)([^\/:@]+)/);
  remoteHost=match?.[1]??"unrecognized-remote-format";
}
const report={
  contract:"bizportal-hostinger-runtime-provenance-readonly-v1",
  invokedFromActualHostingerDeployment: "operator-must-attest",
  directory:root,
  git:{
    commitSha:head&&/^[a-f0-9]{40}$/.test(head)?head:null,
    branch:branch||null,
    repositoryRoot:top||null,
    remoteHost,
    hasRemote:!!remote,
  },
  buildArtifacts:{
    entryBundleSha256:sha256("dist/index.mjs"),
    publicHtmlSha256:sha256("dist/public/index.html"),
    packageJsonSha256:sha256("package.json"),
  },
  // A filename hash is NOT the Git commit or evidence of actual process cwd.
  liveProcessMatchesThisDirectory:false,
  deploymentAuthorized:false,
};
process.stdout.write(JSON.stringify(report,null,2)+"\n");
if(!report.git.commitSha || !report.buildArtifacts.entryBundleSha256){
  process.exitCode=2;
}
