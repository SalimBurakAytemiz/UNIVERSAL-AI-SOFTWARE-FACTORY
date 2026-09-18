import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelRouter, independent, validateConfig } from './model-router.mjs';
import { ProviderError, Stop, Unavailable, atomicJson, readJson, lock, run, parseObject, digest } from './runtime.mjs';
import { cliText, fetchJson, createAdapters, localRoute } from './adapters.mjs';
import { Repository, safeName } from './repository.mjs';
import { Supervisor, validateReview } from './factory-supervisor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = await readJson(path.join(root, 'automation/config.json'));
const registry = await readJson(path.join(root, 'automation/providers.json'));
const model = id => registry.models.find(m => m.id === id);
function fixture(options = {}) {
  let clock = 1000000;
  const calls = [], probes = [], state = options.state || {};
  const router = new ModelRouter({ config: cfg, registry, state, save: async () => {}, now: () => clock,
    adapter: { probe: async m => { probes.push(m.id); return options.probe ? options.probe(m) : {}; },
      invoke: async (m, request) => { calls.push(m.id); return options.invoke ? options.invoke(m, request) : { status: 'READY' }; } } });
  const execute = (args = {}) => router.execute({ role: 'builder', taskKey: 'commit-a', request: '{}', accept: async x => x, ...args });
  return { router, state, calls, probes, execute, advance: ms => { clock += ms; } };
}

test('config enforces paid-off and all immutable Git protections', () => {
  validateConfig(cfg, registry);
  for (const key of Object.keys(cfg.policy)) assert.throws(() => validateConfig({ ...cfg, policy: { ...cfg.policy, [key]: true } }, registry), Stop);
  for (const key of ['autoFetch','autoPullFastForwardOnly','autoPush','verifyRemoteSha','forbidForcePush','forbidHardReset','forbidRebase']) assert.throws(() => validateConfig({ ...cfg, git: { ...cfg.git, [key]: false } }, registry), Stop);
  assert.throws(() => validateConfig({ ...cfg, review: { ...cfg.review, maxCyclesPerMilestone: 4 } }, registry), Stop);
  assert.throws(() => validateConfig(cfg, { models: [{ ...model('openrouter-nemotron'), model: 'paid/model' }] }), Stop);
});

test('Claude remains primary and healthy success never calls a fallback', async () => {
  const f = fixture(); await f.execute(); assert.deepEqual(f.calls, ['claude-primary']);
});

for (const kind of ['QUOTA', 'RATE_LIMIT', 'UNAVAILABLE', 'AUTH', 'TIMEOUT']) {
  test(`Claude ${kind} automatically selects verified OpenCode free builder`, async () => {
    const f = fixture({ invoke: async m => { if (m.adapter === 'claude') throw new ProviderError(kind); return { status: 'READY' }; } });
    const result = await f.execute();
    assert.equal(result.model.id, 'opencode-union-alpha');
    assert.equal(f.state.providers['claude-primary'].availability, 'QUARANTINED');
    assert.deepEqual(f.calls, ['claude-primary', 'opencode-union-alpha']);
  });
}

test('all CLI builders unavailable routes through OmniRoute free adapter', async () => {
  const f = fixture({ invoke: async m => { if (m.adapter !== 'omniroute') throw new ProviderError('UNAVAILABLE'); return { status: 'READY' }; } });
  assert.equal((await f.execute()).model.id, 'nim-deepseek');
});

test('missing future credentials stay INACTIVE and do not block native tools', async () => {
  const f = fixture({ probe: async m => { if (m.adapter === 'omniroute') throw new ProviderError('NO_CREDENTIAL'); return {}; } });
  await f.router.healthCheck();
  assert.equal(f.state.providers['nim-deepseek'].availability, 'INACTIVE');
  assert.equal(f.state.providers['openrouter-nemotron'].lastFailure, 'NO_CREDENTIAL');
  assert.equal((await f.execute()).model.id, 'claude-primary');
});

test('credential arrival and cooldown permit automatic health-based activation', async () => {
  let ready = false;
  const f = fixture({ probe: async m => { if (m.adapter === 'omniroute' && !ready) throw new ProviderError('NO_CREDENTIAL'); return {}; } });
  assert.equal(await f.router.probe(model('nim-deepseek')), false);
  ready = true; f.advance(cfg.health.unavailableCooldownMs + 1);
  assert.equal(await f.router.probe(model('nim-deepseek')), true);
  assert.equal(f.state.providers['nim-deepseek'].availability, 'HEALTHY');
});

test('quarantine prevents duplicate attempts; recovery retries only after successful probe', async () => {
  let failing = true;
  const f = fixture({ invoke: async m => { if (m.adapter === 'claude' && failing) throw new ProviderError('RATE_LIMIT'); return { status: 'READY' }; } });
  await f.execute(); await f.execute({ taskKey: 'commit-b' });
  assert.equal(f.calls.filter(x => x === 'claude-primary').length, 1);
  failing = false; f.advance(cfg.health.cooldownMs + 1);
  await f.execute({ taskKey: 'commit-c' });
  assert.equal(f.calls.filter(x => x === 'claude-primary').length, 2);
});

test('invalid result never repeats for the same model and commit, including restart', async () => {
  const state = {};
  const f = fixture({ state, invoke: async m => { if (m.adapter === 'claude') throw new ProviderError('INVALID_RESPONSE'); return { status: 'READY' }; } });
  await f.execute(); f.advance(cfg.health.maxCooldownMs + 1);
  const restored = fixture({ state: JSON.parse(JSON.stringify(state)) });
  await restored.execute();
  assert.equal(restored.calls.includes('claude-primary'), false);
});

test('NEED_CONTEXT responses are cached across restart without replaying model calls', async () => {
  const f = fixture({ invoke: async () => ({ status: 'NEED_CONTEXT', readPaths: ['package.json'] }) });
  await f.execute(); await f.execute(); assert.equal(f.calls.length, 1);
});

test('Founder approval and task blocker never cause model failover', async () => {
  for (const status of ['FOUNDER_APPROVAL_REQUIRED', 'BLOCKED']) {
    const f = fixture({ invoke: async () => ({ status }) });
    await assert.rejects(f.execute(), Stop); assert.deepEqual(f.calls, ['claude-primary']);
    const restored=fixture({state:JSON.parse(JSON.stringify(f.state))});
    await assert.rejects(restored.execute(),Stop);assert.equal(restored.calls.length,0);
  }
});

test('Codex is primary reviewer; fallback excludes ALL builder families across providers', async () => {
  const contributors = [model('claude-primary'), model('opencode-nemotron')];
  const f = fixture({ invoke: async m => { if (m.adapter === 'codex') throw new ProviderError('UNAVAILABLE'); return { status: 'CLEAN' }; } });
  const result = await f.execute({ role: 'reviewer', contributors });
  assert.deepEqual(f.calls, ['codex-primary', 'opencode-mimo']);
  assert.equal(result.model.family, 'xiaomi-mimo');
  assert.equal(f.router.candidates('reviewer', contributors).some(m => m.id === 'openrouter-nemotron'), false);
  assert.equal(independent(model('codex-primary'), [{ family: 'unknown', model: 'x' }]), false);
  assert.equal(independent(model('codex-primary'), []), false);
  assert.equal(f.router.candidates('reviewer', contributors).some(m => m.id === 'opencode-union-alpha'), false);
});

test('valid reviewer BLOCKED findings are returned, not treated as provider failure', async () => {
  const f = fixture({ invoke: async () => ({ status: 'BLOCKED', findings: ['current blocker'] }) });
  const r = await f.execute({ role: 'reviewer', contributors: [model('claude-primary')] });
  assert.equal(r.output.status, 'BLOCKED'); assert.equal(f.calls.length, 1);
});

test('all unavailable yields bounded recovery wait, not false success', async () => {
  const f = fixture({ probe: async () => { throw new ProviderError('UNAVAILABLE'); } });
  await assert.rejects(f.execute(), Unavailable);
  assert.equal(f.calls.length, 0);
});

test('CLEAN requires exact SHA and empty findings; substring claims are rejected', () => {
  assert.equal(validateReview({ reviewedCommit:'a', status:'CLEAN', findings:[] }, 'a').status, 'CLEAN');
  for (const output of [{ status:'CLEAN', findings:[] }, { reviewedCommit:'b', status:'CLEAN', findings:[] }, { reviewedCommit:'a', status:'BLOCKED', findings:[] }, { reviewedCommit:'a', status:'CLEAN', findings:['bad'] }]) assert.throws(() => validateReview(output,'a'), ProviderError);
  assert.throws(() => parseObject('log INDEPENDENT_REVIEW_RESULT: CLEAN'), ProviderError);
});

test('CLI zero exit error envelopes and output limits are not successes', () => {
  assert.throws(() => cliText({ code:0, stdout:'{"is_error":true,"result":"quota exhausted"}' },'claude'), e => e.kind === 'QUOTA');
  assert.throws(() => cliText({ code:0, stdout:'{"type":"error","error":"rate limit"}' },'opencode'), e => e.kind === 'RATE_LIMIT');
  assert.throws(() => cliText({ code:0, stdout:'{}', overflow:true },'claude'), e => e.kind === 'OUTPUT_LIMIT');
});

test('HTTP retry-after honored; authentication/quota errors classified', async () => {
  for (const [status, kind] of [[401,'AUTH'],[402,'QUOTA'],[429,'RATE_LIMIT'],[503,'TRANSIENT']]) {
    await assert.rejects(fetchJson('http://fixture',{},async () => new Response('{}',{status,headers:{'retry-after':'12'}})), e => e.kind === kind && e.retryAfterMs === 12000);
  }
});

test('no OmniRoute request occurs without credential', async () => {
  await assert.rejects(localRoute('nvidia', cfg.omniroute, {}), e => e.kind === 'NO_CREDENTIAL');
  let calls = 0;
  const adapter = createAdapters(cfg, { root, env:{}, fetcher:async () => { calls++; } });
  await assert.rejects(adapter.probe(model('nim-deepseek')), e => e.kind === 'NO_CREDENTIAL');
  assert.equal(calls,0);
});

for (const bad of ['../secret','C:/outside','/outside','.git/config','.env','src/../../secret','src\\escape','file:stream','NUL.txt','src/name.','.ai/../state']) {
  test(`proposal path rejected: ${bad}`, () => assert.throws(() => safeName(bad), Stop));
}

test('atomic state persists fields and lock prevents concurrent supervisors', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(),'factory-state-'));
  t.after(() => rm(temp,{recursive:true,force:true}));
  const file = path.join(temp,'state.json'); await atomicJson(file,{phase:0,providers:{a:'HEALTHY'}});
  assert.equal((await readJson(file)).phase,0);
  const release = await lock(path.join(temp,'run.lock'));
  await assert.rejects(lock(path.join(temp,'run.lock')), {code:'EEXIST'});
  await release();
});

function supervisorFixture(statePatch = {}) {
  const state = { step:'BUILD', contributors:[], ...statePatch }, calls=[];
  const repo = { head:async ()=>'head', prepare:async()=>{}, sync:async()=>{}, push:async()=>{calls.push('push');return 'head';}, validation:async()=>({passed:true,output:'ok'}) };
  const supervisor = new Supervisor({root,config:cfg,registry,state,save:async()=>{},repo,adapter:{}});
  supervisor.request = async (role) => { calls.push(role); };
  return {state,supervisor,calls};
}

test('review limit survives restart and stops before fourth review/remediation', async () => {
  for (const step of ['REVIEW','REMEDIATE']) {
    const f=supervisorFixture({step,reviewCycle:3});
    await assert.rejects(f.supervisor.step(),Stop); assert.deepEqual(f.calls,[]);
  }
});
test('review resume does not increment cycle for each provider attempt', async () => {
  const f=supervisorFixture({step:'REVIEW_PENDING',reviewCycle:2});
  await f.supervisor.step(); assert.equal(f.state.reviewCycle,2); assert.deepEqual(f.calls,['reviewer']);
});
test('same reviewed commit is not reviewed again', async () => {
  const f=supervisorFixture({step:'REVIEW',reviews:{head:{result:'BLOCKED'}}});
  await assert.rejects(f.supervisor.step(),Stop); assert.deepEqual(f.calls,[]);
});
test('validation must pass before push; new review begins only after SHA push verification', async () => {
  const f=supervisorFixture({step:'VALIDATE'});
  await f.supervisor.step(); assert.equal(f.state.step,'PUSH'); assert.deepEqual(f.calls,[]);
  await f.supervisor.step(); assert.equal(f.state.step,'REVIEW'); assert.deepEqual(f.calls,['push']);
  await f.supervisor.step(); assert.equal(f.state.reviewCycle,1); assert.deepEqual(f.calls,['push','reviewer']);
});
test('checkpoint transition requires CLEAN for current HEAD', async () => {
  const f=supervisorFixture({step:'ADVANCE',lastReviewResult:'CLEAN',currentReviewedCommit:'other'});
  await assert.rejects(f.supervisor.step(),Stop);
});
test('interrupted proposal and unexpected HEAD fail closed', async () => {
  for (const patch of [{pendingApply:{}},{expectedHead:'different'}]) {
    const f=supervisorFixture(patch); await assert.rejects(f.supervisor.step(),Stop);
  }
});

test('real local Git flow: bootstrap, proposal commit, push, remote SHA, ff-only and divergence guard', async t => {
  const temp=await mkdtemp(path.join(os.tmpdir(),'factory-git-'));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const bare=path.join(temp,'remote.git'), local=path.join(temp,'local'), peer=path.join(temp,'peer');
  await mkdir(local);
  async function git(cwd,...args) { const r=await run('git',args,{cwd}); assert.equal(r.code,0,r.stderr); return r.stdout.trim(); }
  await git(temp,'init','--bare',bare); await git(local,'init');
  await git(local,'config','user.name','Factory Test'); await git(local,'config','user.email','factory@example.invalid');
  await git(local,'remote','add','origin',bare);
  await writeFile(path.join(local,'.gitignore'),'.ai/automation/\n');
  await writeFile(path.join(local,'README.md'),'baseline\n');
  const repo=new Repository(local,cfg); await repo.prepare();
  const before=await repo.head();
  const state={};
  const proposal={baseCommit:before,riskLevel:1,requiresFounderApproval:false,files:[{path:'src/a.txt',baseSha256:null,content:'new content\n'}]};
  const after=await repo.apply(proposal,'builder',before,state,async()=>{});
  assert.notEqual(before,after); assert.equal(state.pendingApply,null); assert.equal(await repo.push(),after);
  assert.equal(await repo.remoteSha(cfg.git.workBranch),after);
  await git(temp,'clone','--branch',cfg.git.workBranch,bare,peer);
  await git(peer,'config','user.name','Peer'); await git(peer,'config','user.email','peer@example.invalid');
  await writeFile(path.join(peer,'peer.txt'),'remote change'); await git(peer,'add','.'); await git(peer,'commit','-m','remote change'); await git(peer,'push');
  await repo.sync(); assert.equal(await repo.head(),await git(peer,'rev-parse','HEAD'));
  await writeFile(path.join(local,'local.txt'),'local'); await git(local,'add','.'); await git(local,'commit','-m','local');
  await writeFile(path.join(peer,'peer.txt'),'diverge'); await git(peer,'add','.'); await git(peer,'commit','-m','diverge'); await git(peer,'push');
  await assert.rejects(repo.sync(), /diverged/);
});

test('all proposal files checked before mutation; canonical, risk and stale hashes blocked', async t => {
  const temp=await mkdtemp(path.join(os.tmpdir(),'factory-proposal-')); t.after(()=>rm(temp,{recursive:true,force:true}));
  await writeFile(path.join(temp,'a.txt'),'original');
  const repo=new Repository(temp,cfg); repo.head=async()=>'a'; repo.clean=async()=>{};
  const valid={path:'a.txt',baseSha256:digest('original'),content:'changed'};
  for (const proposal of [
    {riskLevel:5,requiresFounderApproval:false,files:[valid]},
    {riskLevel:1,requiresFounderApproval:true,files:[valid]},
    {riskLevel:1,requiresFounderApproval:false,files:[valid,{path:'ARCHITECTURE-CONSTITUTION.md',baseSha256:null,content:'bad'}]},
    {riskLevel:1,requiresFounderApproval:false,files:[{...valid,baseSha256:'wrong'}]},
    {riskLevel:1,requiresFounderApproval:false,files:[{path:'migrations/drop.sql',baseSha256:null,content:'DROP TABLE users'}]}
  ]) {
    await assert.rejects(repo.apply({...proposal,baseCommit:'a'},'builder','a',{},async()=>{}));
    assert.equal(await readFile(path.join(temp,'a.txt'),'utf8'),'original');
  }
});

test('OmniRoute pins connection and model, disables fallback, rejects paid catalog or substituted response', async () => {
  const target=model('openrouter-nemotron');
  let paid=false, substitute=false, sent=[];
  const adapter=createAdapters(cfg,{root,env:{FACTORY_OMNIROUTE_API_KEY:'fixture-only'},
    routeResolver:async()=>({apiKey:'fixture-only',connectionId:'one-connection',baseUrl:'http://127.0.0.1:20128/v1'}),
    fetcher:async(url,options)=>{
      if(url.startsWith('https://openrouter.ai/')) return new Response(JSON.stringify({data:[{id:target.model,pricing:{prompt:paid?'1':'0',completion:'0'}}]}));
      sent.push(JSON.parse(options.body));
      assert.equal(options.headers['x-omniroute-connection'],'one-connection');
      return new Response(JSON.stringify({model:substitute?'paid/model':target.model,choices:[{finish_reason:'stop',message:{content:'{"status":"READY"}'}}]}));
    }});
  assert.equal((await adapter.invoke(target,'{}')).status,'READY');
  assert.equal(sent[0].model,`openrouter/${target.model}`);
  assert.equal(sent[0].provider.allow_fallbacks,false);
  assert.deepEqual(sent[0].provider.max_price,{prompt:0,completion:0});
  paid=true; await assert.rejects(adapter.invoke(target,'{}'),e=>e.kind==='CONFIG'); assert.equal(sent.length,1);
  paid=false; substitute=true; await assert.rejects(adapter.invoke(target,'{}'),e=>e.kind==='MODEL_MISMATCH');
});

test('OpenCode disables every tool and pins primary/helper model; native paid API keys are stripped', async t => {
  const temp=await mkdtemp(path.join(os.tmpdir(),'factory-adapter-'));t.after(()=>rm(temp,{recursive:true,force:true}));
  let seen;
  const adapter=createAdapters(cfg,{root:temp,env:{ANTHROPIC_API_KEY:'never-forward',OPENAI_API_KEY:'never-forward',CODEX_API_KEY:'never-forward',FACTORY_OMNIROUTE_API_KEY:'never-forward'},
    runner:async(command,args,options)=>{seen={command,args,options};return {code:0,stdout:'{"type":"text","part":{"text":"{\\"status\\":\\"READY\\"}"}}',stderr:''};}});
  await adapter.invoke(model('opencode-union-alpha'),'input with " & powershell tokens');
  assert.equal(seen.args.includes('--standalone'),true);
  const config=JSON.parse(seen.options.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.model,'opencode/union-alpha');assert.equal(config.small_model,config.model);assert.deepEqual(config.permission,{'*':'deny'});
  assert.equal(seen.options.env.OPENAI_API_KEY,undefined);assert.equal(seen.options.env.ANTHROPIC_API_KEY,undefined);
  assert.equal(seen.options.env.FACTORY_OMNIROUTE_API_KEY,undefined);
});

test('full mocked milestone: review block, remediation, clean, planner fallback and progress', async t => {
  const temp=await mkdtemp(path.join(os.tmpdir(),'factory-loop-'));t.after(()=>rm(temp,{recursive:true,force:true}));
  await mkdir(path.join(temp,'prompts'));
  for(const name of ['AUTO-BUILDER.md','AUTO-REVIEW.md','AUTO-NEXT.md']) await writeFile(path.join(temp,'prompts',name),await readFile(path.join(root,'prompts',name)));
  let head='h0', reviews=0; const calls=[],state={};
  const repo={prepare:async()=>{},sync:async()=>{},head:async()=>head,clean:async()=>{},remoteSha:async()=>head,
    context:async()=>({head,tree:[],files:[]}),apply:async()=>{head=`h${Number(head.slice(1))+1}`;return head;},
    validation:async()=>({passed:true,output:'tests passed'}),push:async()=>{calls.push('push');return head;}};
  const adapter={probe:async()=>({}),invoke:async(m,raw)=>{
    const request=JSON.parse(raw);calls.push(`${request.role}:${m.id}`);
    if(request.role==='planner' && m.adapter==='claude') throw new ProviderError('QUOTA');
    if(request.role==='reviewer'){
      reviews++;
      return {taskId:request.taskId,status:reviews===1?'BLOCKED':'CLEAN',reviewedCommit:head,
        findings:reviews===1?[{severity:'P1',file:'x',reproduction:'x',requirement:'x',reason:'x'}]:[]};
    }
    return {taskId:request.taskId,status:'READY',baseCommit:head,riskLevel:1,requiresFounderApproval:false,files:[]};
  }};
  const supervisor=new Supervisor({root:temp,config:{...cfg,review:{...cfg.review,maxMilestonesPerRun:1}},registry,state,save:async()=>{},repo,adapter});
  await supervisor.start();
  assert.equal(state.completedMilestonesThisRun,1);assert.equal(state.status,'RUN_LIMIT_REACHED');
  assert.equal(reviews,2);assert.equal(calls.includes('planner:opencode-union-alpha'),true);
  assert.equal(calls.filter(x=>x==='push').length,3);
});


test('malformed risk metadata is invalid response; explicit authority signals stop', async () => {
  const { validateProposalRisk } = await import('./repository.mjs');
  for (const proposal of [{}, { riskLevel: '1', requiresFounderApproval: false }, { riskLevel: 1 }]) assert.throws(() => validateProposalRisk(proposal), ProviderError);
  for (const proposal of [{ riskLevel: 5, requiresFounderApproval: false }, { requiresFounderApproval: true }]) assert.throws(() => validateProposalRisk(proposal), Stop);
  assert.doesNotThrow(() => validateProposalRisk({ riskLevel: 1, requiresFounderApproval: false }));
});
test('acceptance safety stop is persisted and cannot be bypassed on restart', async () => {
  const f = fixture();
  await assert.rejects(f.execute({ accept: async () => { throw new Stop('protected proposal'); } }), Stop);
  assert.equal(f.state.lastProposal.model, 'claude-primary');
  assert.equal(f.state.attempts['commit-a:builder:claude-primary'].status, 'BLOCKED');
  const restored = fixture({ state: JSON.parse(JSON.stringify(f.state)) });
  await assert.rejects(restored.execute(), Stop);
  assert.equal(restored.calls.length, 0);
});

async function recoveryFixture(status = 'CLEAN') {
  const { recoverReview } = await import('./review-recovery.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uasf-recovery-'));
  const head = 'a'.repeat(40);
  const state = { status: 'FOUNDER_ATTENTION_REQUIRED', reviewCycle: 3, remediationCount: 3, reviews: {}, providers: { 'codex-primary': { availability: 'HEALTHY', evidence: { probe: 'authenticated-inference', model: model('codex-primary').model } } }, contributors: [{ model: 'sonnet', family: 'anthropic-claude' }], currentReviewedCommit: 'b'.repeat(40) };
  const supervisor = { root: dir, config: cfg, registry, router: { registry }, state, save: async () => {},
    repo: { clean: async () => {}, head: async () => head, remoteSha: async () => head },
    request: async () => {
      const artifact = { reviewerId: 'codex-primary', family: model('codex-primary').family, model: model('codex-primary').model, reviewedCommit: head, result: { status, reviewedCommit: head, findings: status === 'CLEAN' ? [] : [{ severity:'P1', file:'x', reproduction:'x', requirement:'x', reason:'x' }] } };
      await atomicJson(path.join(dir, '.ai/automation/reviews', head + '.json'), artifact);
      state.reviews[head] = { ...artifact, artifactDigest: digest(JSON.stringify(artifact)) };
    } };
  return { dir, head, state, supervisor, run: options => recoverReview(supervisor, { head, authorized: true, ...options }) };
}
for (const status of ['CLEAN', 'BLOCKED']) test('authorized recovery ' + status + ' preserves cycles and rejects replay', async () => {
  const f = await recoveryFixture(status);
  try {
    const result = await f.run();
    assert.equal(result.automaticCyclesPreserved, 3);
    assert.equal(f.state.reviewCycle, 3); assert.equal(f.state.remediationCount, 3);
    assert.equal(f.state.status, status === 'CLEAN' ? 'RECOVERY_CLEAN' : 'FOUNDER_ATTENTION_REQUIRED');
    assert.equal((await readJson(path.join(f.dir,'.ai/automation/recoveries',f.head+'.json'))).status,status);
    await assert.rejects(f.run(), /already reviewed|Founder attention/);
  } finally { await rm(f.dir,{recursive:true,force:true}); }
});
test('recovery rejects missing authorization, old SHA, remote mismatch and interrupted apply', async () => {
  const f = await recoveryFixture();
  try {
    await assert.rejects(f.run({authorized:false}), /authorization/);
    await assert.rejects(f.run({head:'b'.repeat(40)}), /target/);
    f.supervisor.repo.remoteSha=async () => 'c'.repeat(40);
    await assert.rejects(f.run(), /target/);
    f.state.pendingApply={}; await assert.rejects(f.run(), /interrupted/);
    assert.equal(f.state.reviewRecoveries,undefined);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});
test('recovery rejects builder-family reviewer and consumes failed recovery', async () => {
  const f=await recoveryFixture();
  try {
    f.state.contributors.push({model:'codex-session',family:'openai-gpt'});
    await assert.rejects(f.run(),/not independent/);
    assert.equal(f.state.status,'FOUNDER_ATTENTION_REQUIRED');
    await assert.rejects(f.run(),/already reviewed/);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});
test('recovery never accepts wrong SHA or CLEAN with findings', async () => {
  for(const kind of ['sha','findings']) {
    const f=await recoveryFixture();
    try {
      const request=f.supervisor.request;
      f.supervisor.request=async()=>{await request(); const r=f.state.reviews[f.head].result; if(kind==='sha')r.reviewedCommit='b'.repeat(40); else r.findings=[{}];};
      await assert.rejects(f.run(),ProviderError);
      assert.equal(f.state.status,'FOUNDER_ATTENTION_REQUIRED');
      assert.equal(f.state.reviewCycle,3);
    } finally {await rm(f.dir,{recursive:true,force:true});}
  }
});

test('real CLI recovery dispatch exits normally and releases lock on invalid authorization', async () => {
  const { cp } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uasf-cli-recovery-'));
  try {
    await cp(path.join(root,'automation'), path.join(dir,'automation'), {recursive:true});
    const result = await run(process.execPath, [path.join(dir,'automation/factory-supervisor.mjs'),'--recover-review','invalid'], {cwd:dir});
    assert.equal(result.code,2);
    assert.match(result.stderr,/full SHA/);
    assert.doesNotMatch(result.stderr,/unsettled top-level await/);
    assert.equal(await readJson(path.join(dir,'.ai/automation/state.json')).then(s=>s.status),'FOUNDER_ATTENTION_REQUIRED');
    const release = await lock(path.join(dir,'.ai/automation/supervisor.lock')); await release();
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('recovery rejects old target even without indexed review and rejects non-attention state', async () => {
  const f = await recoveryFixture();
  try {
    f.state.currentReviewedCommit = f.head;
    await assert.rejects(f.run(), /already reviewed/);
    f.state.status = 'RUNNING';
    await assert.rejects(f.run(), /Founder attention/);
  } finally { await rm(f.dir, {recursive:true, force:true}); }
});

test('recovery prefers Codex and validates persisted artifact binding', async () => {
  const f = await recoveryFixture();
  try {
    const request = f.supervisor.request;
    f.supervisor.request = async () => {
      assert.equal(f.supervisor.router.registry.models[0].id, 'codex-primary');
      await request();
      const record = f.state.reviews[f.head];
      const artifact = await readJson(path.join(f.dir, '.ai/automation/reviews', f.head + '.json'));
      artifact.reviewedCommit = 'c'.repeat(40);
      await atomicJson(path.join(f.dir, '.ai/automation/reviews', f.head + '.json'), artifact);
      record.artifactDigest = digest(JSON.stringify(artifact));
    };
    await assert.rejects(f.run(), /binding mismatch/);
    assert.equal(f.state.status, 'FOUNDER_ATTENTION_REQUIRED');
    assert.equal(f.state.reviewCycle, 3);
    assert.equal(f.supervisor.router.registry, registry);
  } finally { await rm(f.dir, {recursive:true, force:true}); }
});

for (const scenario of ['primary', 'nemotron', 'fallback', 'same-family', 'unavailable', 'blocked']) {
  test('real supervisor recovery routing: ' + scenario, async () => {
    const { recoverReview } = await import('./review-recovery.mjs');
    const f = await recoveryFixture();
    const calls = [], probes = [];
    try {
      await mkdir(path.join(f.dir, 'prompts'));
      await writeFile(path.join(f.dir, 'prompts/AUTO-REVIEW.md'), await readFile(path.join(root, 'prompts/AUTO-REVIEW.md')));
      if (scenario !== 'primary') f.state.contributors.push({model:'codex-session', family:'openai-gpt'});
      f.state.contributors.push({model:'opencode/mimo-v2.5-free', family:'xiaomi-mimo'});
      if (scenario === 'same-family') f.state.contributors.push({model:'nemotron-builder', family:'nvidia-nemotron'});
      const originalContributors = structuredClone(f.state.contributors);
      const s = new Supervisor({root:f.dir, config:cfg, registry, state:f.state, save:async()=>{},
        repo:{...f.supervisor.repo, context:async()=>({head:f.head,tree:[],files:[]})},
        adapter:{probe:async m=>{
          probes.push(m.id);
          if (scenario === 'unavailable' || (scenario === 'fallback' && ['nim-nemotron-super','opencode-nemotron'].includes(m.id))) throw new ProviderError('AUTH');
          return {probe:'authenticated-inference',model:m.model};
        }, invoke:async (m, raw)=>{
          calls.push(m.id);
          assert.equal(independent(m, originalContributors),true);
          assert.equal(f.state.providers[m.id].availability,'HEALTHY');
          const request=JSON.parse(raw);
          return {taskId:request.taskId,reviewedCommit:request.reviewedCommit,status:scenario === 'blocked' ? 'BLOCKED' : 'CLEAN', findings:scenario === 'blocked' ? [{severity:'P1',file:'x',reproduction:'x',requirement:'x',reason:'x'}] : []};
        }}});
      if (scenario === 'unavailable') {
        await assert.rejects(recoverReview(s,{head:f.head,authorized:true}),Unavailable);
        assert.equal(f.state.status,'FOUNDER_ATTENTION_REQUIRED');
        assert.deepEqual(calls,[]);
      } else {
        const result=await recoverReview(s,{head:f.head,authorized:true});
        const expected=scenario === 'primary' ? 'codex-primary' : ['fallback','same-family'].includes(scenario) ? 'nim-deepseek' : 'nim-nemotron-super';
        assert.deepEqual(calls,[expected]);
        assert.equal(result.reviewerId,expected);
        assert.equal(result.reviewerFamily,model(expected).family);
        assert.equal(result.reviewerHealth.availability,'HEALTHY');
        assert.equal(result.automaticCyclesPreserved,3);
        assert.equal(result.status,scenario === 'blocked' ? 'BLOCKED' : 'CLEAN');
        assert.equal(f.state.status,scenario === 'blocked' ? 'FOUNDER_ATTENTION_REQUIRED' : 'RECOVERY_CLEAN');
      }
      assert.deepEqual(f.state.contributors,originalContributors);
      assert.equal(f.state.reviewCycle,3);
      assert.equal(f.state.remediationCount,3);
      if (scenario !== 'primary') assert.equal(probes.includes('codex-primary'),false);
      if (scenario === 'same-family') assert.equal(probes.includes('opencode-nemotron') || probes.includes('openrouter-nemotron'),false);
    } finally { await rm(f.dir,{recursive:true,force:true}); }
  });
}

test('recovery selection excludes paid, disabled, unknown and all contributor families', async () => {
  const { recoveryRegistry } = await import('./review-recovery.mjs');
  const contributors = [{family:'openai-gpt',model:'codex-session'},{family:'nvidia-nemotron',model:'other-nemotron'}];
  const input={models:[...registry.models,{...model('opencode-mimo'),id:'paid',cost:'paid'},{...model('opencode-mimo'),id:'unknown',family:'unknown'}]};
  const selected=recoveryRegistry(input,contributors).models;
  assert.equal(selected.some(m=>['codex-primary','opencode-nemotron','openrouter-nemotron','paid','unknown'].includes(m.id)),false);
  assert.equal(selected.every(m=>m.cost==='free' && independent(m,contributors)),true);
});

for (const kind of ['family','model','health','contributors']) test('recovery rejects altered provenance: ' + kind, async () => {
  const f=await recoveryFixture();
  try {
    const request=f.supervisor.request;
    f.supervisor.request=async()=>{
      await request();
      if(kind==='health') f.state.providers['codex-primary'].availability='QUARANTINED';
      else if(kind==='contributors') f.state.contributors.push({family:'new-family',model:'other'});
      else {
        const artifact=await readJson(path.join(f.dir,'.ai/automation/reviews',f.head+'.json'));
        artifact[kind]='forged';
        await atomicJson(path.join(f.dir,'.ai/automation/reviews',f.head+'.json'),artifact);
        f.state.reviews[f.head].artifactDigest=digest(JSON.stringify(artifact));
      }
    };
    await assert.rejects(f.run(),/provenance|history changed/);
    assert.equal(f.state.status,'FOUNDER_ATTENTION_REQUIRED');
    assert.equal(f.state.reviewCycle,3);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});

async function failedInfrastructureRecovery() {
  const f = await recoveryFixture();
  const request = f.supervisor.request;
  for (const m of registry.models) f.state.providers[m.id] = { ...f.state.providers[m.id], lastFailure:'NO_CREDENTIAL' };
  f.supervisor.request = async () => { throw new Unavailable('All reviewer candidates are quarantined or unavailable.',Date.now()+1000); };
  await assert.rejects(f.run(),Unavailable);
  assert.equal(f.state.reviewRecoveries[f.head].failureCategory,'INFRASTRUCTURE_ONLY');
  f.supervisor.request = request;
  return f;
}

test('one explicitly authorized infrastructure retry preserves original audit, contributors and cycles', async () => {
  const f=await failedInfrastructureRecovery();
  try {
    const previous=structuredClone(f.state.reviewRecoveries[f.head]);
    const auditPath=path.join(f.dir,'.ai/automation/recoveries',f.head+'.json');
    const auditBefore=await readFile(auditPath,'utf8');
    await assert.rejects(f.run(),/explicit one-time/);
    await assert.rejects(f.run({retryPreviousAttempt:previous.id,authorized:false}),/authorization/);
    await assert.rejects(f.run({retryPreviousAttempt:'wrong'}),/explicit one-time/);
    const result=await f.run({retryPreviousAttempt:previous.id});
    assert.equal(result.status,'CLEAN');
    assert.equal(result.previousRecoveryAttempt,previous.id);
    assert.equal(result.targetHead,f.head);
    assert.equal(result.founderAuthorization.targetHead,f.head);
    assert.notEqual(result.id,previous.id);
    assert.notEqual(result.founderAuthorization.id,previous.founderAuthorization.id);
    assert.equal(await readFile(auditPath,'utf8'),auditBefore);
    assert.deepEqual(f.state.reviewRecoveries[f.head],previous);
    assert.deepEqual(f.state.contributors,previous.contributors);
    assert.equal(f.state.reviewCycle,3); assert.equal(f.state.remediationCount,3);
    assert.equal((await readJson(path.join(f.dir,'.ai/automation/recoveries',f.head+'.'+result.id+'.json'))).previousRecoveryAttempt,previous.id);
  } finally { await rm(f.dir,{recursive:true,force:true}); }
});

test('infrastructure retry is consumed even if infrastructure fails again', async () => {
  const f=await failedInfrastructureRecovery();
  try {
    const previous=f.state.reviewRecoveries[f.head];
    f.supervisor.request=async()=>{throw new Unavailable('All reviewer candidates are quarantined or unavailable.');};
    await assert.rejects(f.run({retryPreviousAttempt:previous.id}),Unavailable);
    await assert.rejects(f.run({retryPreviousAttempt:previous.id}),/explicit one-time/);
    assert.equal(f.state.reviewCycle,3);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});

for(const status of ['CLEAN','BLOCKED','STARTED']) test('prior '+status+' permanently prohibits infrastructure retry',async()=>{
  const f=await failedInfrastructureRecovery();
  try {
    const p=f.state.reviewRecoveries[f.head]; p.status=status;
    await atomicJson(path.join(f.dir,'.ai/automation/recoveries',f.head+'.json'),p);
    await assert.rejects(f.run({retryPreviousAttempt:p.id}),/not an infrastructure/);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});

test('legacy infrastructure failure requires no reviewer invocation and matching prior artifact', async()=>{
  const {infrastructureRetryAllowed}=await import('./review-recovery.mjs');
  const p={status:'FAILED',head:'a'.repeat(40),authorizedAt:'2026-09-18T01:00:00Z',finishedAt:'2026-09-18T01:01:00Z',reason:'All reviewer candidates are quarantined or unavailable.'};
  assert.equal(infrastructureRetryAllowed(p,{}),true);
  assert.equal(infrastructureRetryAllowed({...p,reason:'INVALID_RESPONSE'},{}),false);
  assert.equal(infrastructureRetryAllowed(p,{attempts:{'task:reviewer:id':{startedAt:Date.parse('2026-09-18T01:00:30Z'),status:'FAILED'}}}),false);
  assert.equal(infrastructureRetryAllowed(p,{reviewerDecisions:[{targetHead:p.head,status:'BLOCKED'}]}),false);
  const f=await failedInfrastructureRecovery();
  try {
    await atomicJson(path.join(f.dir,'.ai/automation/recoveries',f.head+'.json'),{...f.state.reviewRecoveries[f.head],reason:'tampered'});
    await assert.rejects(f.run({retryPreviousAttempt:f.state.reviewRecoveries[f.head].id}),/not an infrastructure/);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});

test('received reviewer decision is persisted before invalid output acceptance and forbids retry',async()=>{
  const f=fixture({invoke:async()=>({status:'CLEAN',reviewedCommit:'wrong',findings:[]})});
  await assert.rejects(f.execute({role:'reviewer',request:JSON.stringify({reviewedCommit:'target'}),contributors:[{family:'anthropic-claude',model:'sonnet'}],accept:async()=>{throw new Stop('Malformed evidence');}}),Stop);
  assert.equal(f.state.reviewerDecisions[0].targetHead,'target');
  assert.equal(f.state.reviewerDecisions[0].status,'CLEAN');
  const {infrastructureRetryAllowed}=await import('./review-recovery.mjs');
  assert.equal(infrastructureRetryAllowed({head:'target',status:'FAILED',failureCategory:'INFRASTRUCTURE_ONLY'},f.state),false);
});

test('NIM credentials stay in original root; free-tier opt-in required and OpenRouter fields omitted',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'uasf-nim-'));
  try {
    const credentialRoot=path.join(temp,'original'),snapshot=path.join(temp,'snapshot');
    await mkdir(snapshot);
    let body;
    const adapter=createAdapters(cfg,{root:snapshot,credentialRoot,env:{},routeResolver:async(_p,_g,env)=>{
      assert.equal(env.FACTORY_OMNIROUTE_API_KEY,'fixture-only');
      return {apiKey:'fixture-only',connectionId:'one',baseUrl:'http://127.0.0.1:20128/v1'};
    },fetcher:async(_url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({model:'nvidia/nemotron-3-super-120b-a12b',choices:[{finish_reason:'stop',message:{content:'{"status":"READY"}'}}]}));}});
    await atomicJson(path.join(credentialRoot,'.ai/automation/credentials.json'),{omnirouteApiKey:'fixture-only'});
    await assert.rejects(adapter.invoke(model('nim-nemotron-super'),'{}'),e=>e.kind==='NO_CREDENTIAL');
    assert.equal(body,undefined);
    await atomicJson(path.join(credentialRoot,'.ai/automation/credentials.json'),{omnirouteApiKey:'fixture-only',nimFreeTier:true});
    assert.equal((await adapter.invoke(model('nim-nemotron-super'),'{}')).status,'READY');
    assert.equal(body.model,'nvidia/nvidia/nemotron-3-super-120b-a12b');
    assert.equal(body.provider,undefined);
  } finally {await rm(temp,{recursive:true,force:true});}
});

test('unrelated exact aliases cannot block pinned route; target, wildcard, settings aliases and combos do',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const temp=await mkdtemp(path.join(os.tmpdir(),'uasf-route-'));
  const dbPath=path.join(temp,'route.sqlite'),db=new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE key_value(namespace TEXT,key TEXT,value TEXT); CREATE TABLE combos(name TEXT); CREATE TABLE provider_nodes(id TEXT,prefix TEXT); CREATE TABLE provider_connections(id TEXT,provider TEXT,is_active INTEGER,provider_specific_data TEXT);');
    db.prepare('INSERT INTO provider_connections VALUES(?,?,?,?)').run('only','nvidia',1,'{}');
    db.prepare('INSERT INTO key_value VALUES(?,?,?)').run('modelAliases','unrelated-claude','"anthropic/other"');
    const env={FACTORY_OMNIROUTE_API_KEY:'fixture-only',FACTORY_OMNIROUTE_DB:dbPath};
    const route=()=>localRoute('nvidia',cfg.omniroute,env,'nvidia/nemotron-3-super-120b-a12b');
    assert.equal((await route()).connectionId,'only');
    for(const [namespace,key,value] of [['modelAliases','nvidia/nvidia/nemotron-3-super-120b-a12b','"other"'],['modelAliases','nemotron-3-super-120b-a12b','"other"'],['modelAliases','claude-*','"other"'],['settings','wildcardAliases','[{"pattern":"*","target":"paid/model"}]'],['providerAliases','nvidia','"other"']]) {
      db.prepare('INSERT INTO key_value VALUES(?,?,?)').run(namespace,key,value);
      await assert.rejects(route(),e=>e.kind==='CONFIG');
      db.prepare('DELETE FROM key_value WHERE namespace=? AND key=?').run(namespace,key);
    }
    db.prepare('INSERT INTO combos VALUES(?)').run('nvidia/nvidia/nemotron-3-super-120b-a12b');
    await assert.rejects(route(),e=>e.kind==='CONFIG');
  } finally {db.close();await rm(temp,{recursive:true,force:true});}
});

test('milestone advancement preserves lifetime counters/contributors and starts a separate budget',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'uasf-budget-'));
  try {
    await atomicJson(path.join(dir,'.ai/MASTER_STATE.json'),{currentMilestone:'1.2'});
    const state={step:'ADVANCED',reviewCycle:3,remediationCount:3,currentMilestone:'1.1',currentReviewedCommit:'reviewed',contributors:[{model:'builder',family:'openai-gpt'}],reviews:{reviewed:{artifactDigest:'digest'}}};
    const s=new Supervisor({root:dir,config:cfg,registry,state,save:async()=>{},repo:{push:async()=>'closure'},adapter:{}});
    await s.step();
    assert.equal(state.reviewCycle,3); assert.equal(state.remediationCount,3);
    assert.deepEqual(state.contributors,[{model:'builder',family:'openai-gpt'}]);
    assert.equal(state.milestoneHistory.reviewed.reviewCycle,3);
    assert.equal(state.currentMilestone,'1.2');
    assert.equal(state.step,'BUILD'); assert.equal(state.expectedHead,'closure');
    assert.equal(s.milestoneCount('reviewCycle','milestoneReviewCycleBase'),0);
    state.reviewCycle=6;
    assert.equal(s.milestoneCount('reviewCycle','milestoneReviewCycleBase'),3);
    state.milestoneReviewCycleBase=7;
    assert.throws(()=>s.milestoneCount('reviewCycle','milestoneReviewCycleBase'),/Invalid historical/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
