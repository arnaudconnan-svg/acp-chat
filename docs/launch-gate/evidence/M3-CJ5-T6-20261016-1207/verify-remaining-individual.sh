#!/bin/bash
set -uo pipefail
overall=0
for task in health:harness no-openai-runtime:harness mistral:harness title:harness title:conflict:mistral:harness information-routing:mistral:harness exploration:mistral:harness recall-routing:mistral:harness contact-discharge:mistral:harness immediate-alliance:mistral:harness interpretation-rejection:mistral:harness dependency-risk:mistral:harness major-harm-response:mistral:harness acute-crisis-followup:mistral:harness n2-writer:mistral:harness major-harm-risk:mistral:harness suicide-risk:mistral:harness writer:mistral:harness memory:mistral:harness intersession:mistral:harness intersession:source:harness affiliation:mistral:harness state:harness posture:harness analyzers:harness prompts:consistency contract-validator:harness human-support:harness flags:harness conversation-state:harness runtime-schemas:harness debugmeta-unit:harness auth-conversation:harness chat-routing:harness branching:harness transcript:harness crisis-routing:harness llm-messages:harness conversation-data:harness ui-layout:verify; do
  echo "COMMAND=npm run $task"
  npm run "$task"
  result=$?
  echo "RESULT=$task EXIT_CODE=$result"
  if [ "$result" -ne 0 ]; then overall=1; fi
done
exit "$overall"
