import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {startPostgres,down,docker,compose} from './local.mjs';
import {test} from 'node:test';
const image=JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./images.json',import.meta.url))).postgres;
test('scoped PostgreSQL startup diagnostics distinguish absent, exited and unhealthy without raw secrets', {timeout:60000}, async()=>{
for(const scenario of ['healthy','network-failure','exited','unhealthy']){
 const directory=await mkdtemp(join(tmpdir(),'credspan-probe-pg-'));await chmod(directory,0o700);
 const deploymentId=randomUUID(),name='credspan-probe-pg-'+deploymentId.slice(0,8),project={directory,deploymentId,name};
 const override=scenario==='exited'?'    entrypoint: [sh, -c, "echo PG_RAW_SENTINEL >&2; exit 23"]\n':scenario==='unhealthy'?'    entrypoint: [sh, -c, "sleep 120"]\n':'';
 const network=scenario==='network-failure'?`networks:\n  default:\n    external: true\n    name: credspan-probe-absent-${deploymentId}\n`:`networks:\n  default:\n    labels: {credspan.deployment: ${deploymentId}}\n`;
 await writeFile(directory+'/compose.yaml',`services:\n  postgres:\n    image: ${image}\n    pull_policy: never\n    labels: {credspan.deployment: ${deploymentId}}\n    environment: {POSTGRES_PASSWORD: synthetic-disposable-probe-only}\n${override}    healthcheck:\n      test: [CMD-SHELL, "echo PG_RAW_SENTINEL; pg_isready -U postgres"]\n      interval: 200ms\n      timeout: 1s\n      retries: ${scenario==='healthy'?30:2}\n${network}`,{mode:0o600});
 try{
  if(scenario==='healthy'){startPostgres(project);compose(project,['stop','postgres']);startPostgres(project);console.log(JSON.stringify({scenario,startedAndRestarted:true}));}
  else{const prior=console.error,records=[];try{console.error=value=>records.push(JSON.parse(value));assert.throws(()=>startPostgres(project));}finally{console.error=prior;}
 const report=records[0].postgresStartup;assert.equal(report.captureComplete,true);assert.equal(report.execution.status,1);assert.ok(Number.isFinite(Date.parse(report.observedAt)));assert.ok(report.elapsedMs>=0);assert.ok(!JSON.stringify(report).includes('synthetic-disposable-probe-only'));assert.ok(!JSON.stringify(report).includes('PG_RAW_SENTINEL'));assert.match(report.containers[0]?.id??'a'.repeat(64),/^[a-f0-9]{64}$/);
 if(scenario==='network-failure'){assert.equal(report.containers.length,0);assert.equal(report.category,'network');}
 if(scenario==='exited'){assert.equal(report.containers[0].status,'exited');assert.equal(report.containers[0].exitCode,23);assert.equal(report.containers[0].oomKilled,false);}
 if(scenario==='unhealthy'){assert.equal(report.containers[0].status,'running');assert.equal(report.containers[0].health.status,'unhealthy');}
 console.log(JSON.stringify({scenario,diagnostics:report}));}
 }finally{down(project,{removeVolumes:true});assert.equal(docker(['ps','-aq','--filter','label=credspan.deployment='+deploymentId]),'');await rm(directory,{recursive:true});}
}

});
