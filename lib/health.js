const DEPLOYED_GIT_COMMIT_UNAVAILABLE = 'unavailable';

function buildHealthPayload(env = process.env) {
  const deployedGitCommit = env.RENDER_GIT_COMMIT;

  return {
    status: 'ok',
    gitCommit:
      typeof deployedGitCommit === 'string' && deployedGitCommit.length > 0
        ? deployedGitCommit
        : DEPLOYED_GIT_COMMIT_UNAVAILABLE
  };
}

module.exports = {
  buildHealthPayload,
  DEPLOYED_GIT_COMMIT_UNAVAILABLE
};
