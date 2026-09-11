'use strict';

const { spawnSync } = require('child_process');

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    stdio: options.captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });

  if (!options.allowFailure && result.status !== 0) {
    const detail = options.captureOutput
      ? `\n${String(result.stderr || '').trim()}`
      : '';
    throw new Error(`git ${args.join(' ')} failed.${detail}`);
  }

  return result;
}

function getGitText(args) {
  const result = runGit(args, { captureOutput: true });
  return String(result.stdout || '').trim();
}

function isAncestor(olderRef, newerRef) {
  const result = runGit(['merge-base', '--is-ancestor', olderRef, newerRef], {
    allowFailure: true,
    captureOutput: true
  });
  return result.status === 0;
}

function ensureCleanWorktree() {
  const status = getGitText(['status', '--porcelain']);
  if (!status) return;
  console.error(
    'preff-git-guard: working tree is not clean. Commit/stash first.'
  );
  process.exit(2);
}

function fetchRefs() {
  runGit(['fetch', 'origin', 'main', 'beta']);
}

function evaluate() {
  const mainRef = 'origin/main';
  const betaRef = 'origin/beta';
  const mainSha = getGitText(['rev-parse', '--short', mainRef]);
  const betaSha = getGitText(['rev-parse', '--short', betaRef]);

  const mainInBeta = isAncestor(mainRef, betaRef);
  const betaInMain = isAncestor(betaRef, mainRef);

  return {
    mainRef,
    betaRef,
    mainSha,
    betaSha,
    mainInBeta,
    betaInMain,
    canFastForwardMainFromBeta: mainInBeta
  };
}

function getDivergence(leftRef, rightRef) {
  const counts = getGitText([
    'rev-list',
    '--left-right',
    '--count',
    `${leftRef}...${rightRef}`
  ]).split(/\s+/);
  return { betaOnly: Number(counts[0] || 0), mainOnly: Number(counts[1] || 0) };
}

function printPostPromotionAnomaly(state) {
  const divergence = getDivergence(state.betaRef, state.mainRef);
  console.error('preff-git-guard: post-promotion beta sync stopped.');
  console.error(
    `- ${state.mainRef}: ${getGitText(['rev-parse', state.mainRef])}`
  );
  console.error(
    `- ${state.betaRef}: ${getGitText(['rev-parse', state.betaRef])}`
  );
  console.error(
    `- divergence: beta-only=${divergence.betaOnly}, main-only=${divergence.mainOnly}`
  );
  console.error('- strict fast-forward beta <- main: no');
  console.error(
    '- no merge, rebase, reset, or force-push was attempted; investigate before continuing.'
  );
}

function printEvaluation(state) {
  console.log('preff-git-guard status:');
  console.log(`- ${state.mainRef}: ${state.mainSha}`);
  console.log(`- ${state.betaRef}: ${state.betaSha}`);

  if (state.mainInBeta && state.betaInMain) {
    console.log('- relation: same commit');
    console.log('- fast-forward main <- beta: yes (already aligned)');
    return;
  }

  if (state.mainInBeta) {
    console.log('- relation: main is ancestor of beta');
    console.log('- fast-forward main <- beta: yes');
    return;
  }

  if (state.betaInMain) {
    console.log('- relation: beta is behind main');
    console.log('- fast-forward main <- beta: no');
    console.log('  action: sync main into beta before pre-FF promotion.');
    return;
  }

  console.log('- relation: main and beta have diverged');
  console.log('- fast-forward main <- beta: no');
  console.log('  action: sync main into beta before pre-FF promotion.');
}

function syncMainIntoBeta() {
  ensureCleanWorktree();
  fetchRefs();

  runGit(['checkout', 'beta']);
  runGit(['pull', '--ff-only', 'origin', 'beta']);
  runGit(['merge', '--no-edit', 'origin/main']);
  runGit(['push', 'origin', 'beta']);

  const state = evaluate();
  printEvaluation(state);
  if (!state.canFastForwardMainFromBeta) {
    console.error(
      'preff-git-guard: sync completed but fast-forward is still impossible.'
    );
    process.exit(1);
  }

  console.log(
    'preff-git-guard: sync successful, main <- beta fast-forward is now possible.'
  );
}

function syncBetaAfterPromotion() {
  ensureCleanWorktree();
  fetchRefs();

  const before = evaluate();
  if (!before.betaInMain) {
    printPostPromotionAnomaly(before);
    process.exit(1);
  }

  runGit(['checkout', 'beta']);
  runGit(['pull', '--ff-only', 'origin', 'beta']);
  runGit(['merge', '--ff-only', 'origin/main']);

  const localSha = getGitText(['rev-parse', 'HEAD']);
  const promotedMainSha = getGitText(['rev-parse', 'origin/main']);
  if (localSha !== promotedMainSha) {
    console.error(
      `preff-git-guard: local beta ${localSha} does not match promoted main ${promotedMainSha}; stopping before push.`
    );
    process.exit(1);
  }

  runGit(['push', 'origin', 'beta']);
  fetchRefs();

  const mainSha = getGitText(['rev-parse', 'origin/main']);
  const betaSha = getGitText(['rev-parse', 'origin/beta']);
  if (mainSha !== betaSha) {
    printPostPromotionAnomaly(evaluate());
    process.exit(1);
  }

  console.log('preff-git-guard: mandatory post-promotion sync successful.');
  console.log(`- origin/main: ${mainSha}`);
  console.log(`- origin/beta: ${betaSha}`);
  console.log('- strict fast-forward beta <- main: yes');
}

function main() {
  const mode = process.argv[2] || 'check';

  if (mode === 'sync') {
    syncMainIntoBeta();
    return;
  }

  if (mode === 'post-promotion-sync') {
    syncBetaAfterPromotion();
    return;
  }

  fetchRefs();
  const state = evaluate();
  printEvaluation(state);
  if (!state.canFastForwardMainFromBeta) {
    process.exit(1);
  }
}

main();
