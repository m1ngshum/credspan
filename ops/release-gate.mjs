import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
export async function requireReleaseCi(env = process.env, request = fetch) {
  if (env.GITHUB_REF !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') || !env.GITHUB_TOKEN) throw Error('Release requires main and an exact source revision');
  const api = async path => {
    const response = await request(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`, { headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('Unable to verify required CI');
    return response.json();
  };
  const result = await api(`actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${env.GITHUB_SHA}&per_page=100`);
  const runs = result.workflow_runs?.filter(run => run.head_sha === env.GITHUB_SHA && run.head_branch === 'main' && run.event === 'push') ?? [];
  const latest = runs.sort((a, b) => b.id - a.id)[0];
  if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') throw Error('Exact main source has no successful completed CI run');
  const jobs = await api(`actions/runs/${latest.id}/jobs?filter=latest&per_page=100`);
  if (!jobs.jobs?.some(job => job.name === 'ci' && job.status === 'completed' && job.conclusion === 'success')) throw Error('Required ci job did not pass');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await requireReleaseCi();
