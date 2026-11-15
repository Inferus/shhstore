# shhstore

A Claude Code plugin for API keys, tokens and passwords that never land in the chat. You type the key into a private field. It goes straight to the OS keychain (macOS Keychain, or libsecret on Linux). Claude only ever works with a placeholder, `{{shh:NAME}}`, and can still put the real key into any `.env` file, config or shell command without seeing it.

## How it works

| What | How |
| --- | --- |
| **Entering a key** | Claude calls `request_secret` and a pane with an input field opens above the prompt. The value goes straight to the keychain and never enters the conversation. You can also start it yourself with `/secret OPENAI_API_KEY`. On macOS, the **Hidden input** button opens a native dialog that masks what you type. |
| **A key pasted into the chat** | It is caught before the message is sent. The plugin recognizes common key formats (OpenAI, Anthropic, OpenRouter, GitHub, GitLab, Stripe, AWS, Google, Slack, Groq, Hugging Face, xAI, Perplexity, Resend, SendGrid, npm, Telegram, PEM private keys) and `.env` lines such as `*_KEY=`, `*_TOKEN=`, `*_SECRET=` and `*_PASSWORD=`. The key is stored and the model sees `{{shh:OPENAI_API_KEY}}` instead. |
| **Using a key** | In `Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit` and MCP tool calls, `{{shh:NAME}}` is replaced with the real value right before the tool runs. A placeholder naming an unknown secret makes the call fail, so the literal placeholder never ends up in a file. |
| **Redaction** | Every stored value is replaced back with its placeholder in every tool result (cat, Read, Grep, logs, errors) and in what the engine injects (changed-file diffs, @-mentions, hook output). This means Claude can read a `.env` file and sees only placeholders in it. |
| **Writing a .env** | `write_secret_to_env(name, file, var?)` adds or updates `VAR=value` and leaves the other lines alone. A new file is created with `chmod 600`. If the file is not git-ignored, the tool's answer says so. |
| **Writing the placeholder itself** | For docs and examples, put a backslash in front: `\{{shh:NAME}}` is written out as the literal text `{{shh:NAME}}`, not expanded. |

Tools the model gets: `request_secret`, `list_secrets`, `write_secret_to_env`, `delete_secret` (asks you to confirm before deleting).
Slash commands: `/secret NAME` (enter a secret), `/secrets` (list names, never values).

## Examples

```
you:    hook this project up to OpenAI
claude: → request_secret(OPENAI_API_KEY)     ← you paste the key into the pane
        → write_secret_to_env(OPENAI_API_KEY, .env)
        → Bash: curl -H "Authorization: Bearer {{shh:OPENAI_API_KEY}}" https://api.openai.com/v1/models
```

```
you:             here's the key sk-proj-abc…xyz, put it in apps/web/.env.local as NEXT_OPENAI_KEY
the model sees:  here's the key {{shh:OPENAI_API_KEY}}, put it in apps/web/.env.local as NEXT_OPENAI_KEY
```

## Install

In a Claude Code terminal session:

```
/plugin install shhstore --marketplace Inferus/shhstore
```

Answer `y` to add the marketplace, then pick a scope (`user` makes it work in every project).

From a shell:

```
claude plugin install shhstore --marketplace Inferus/shhstore
```

You need a Claude Code build that supports function-hook mods (2.1.32x or later). That API is in early access and may change between releases.

Development: `claude plugin test .` runs the tests and `claude plugin validate .` checks the plugin.

## Where secrets are stored

- **macOS:** the Keychain, service `shhstore`, account `NAME`. To see or delete them, open Keychain Access and search for `shhstore`.
- **Linux:** libsecret (`secret-tool`), with attributes `service=shhstore account=NAME`.
- **Neither available:** the plugin's own JSON store under `~/.claude`, in plain text. A notice says so when the session starts.
- The list of names (without values) is kept in the plugin's store.

## Limitations

- This guards against **accidental** leaks. It does not protect against a malicious model or a prompt injection. A command that uses a placeholder can send the key anywhere, or print it encoded (base64, one character at a time), and redaction only catches the exact value.
- The pane's input field shows what you type on screen. The text still never reaches the model. Use the macOS dialog button if you want masked input.
- Values shorter than 6 characters are not redacted, so ordinary output stays intact.
- Only values stored in shhstore are redacted. A key that already sits in a `.env` file but was never stored is visible to the model. Store it once with `/secret`, or paste the `KEY=...` line into the chat and it will be intercepted.
- Slash command arguments are not redacted. Type `/secret NAME` without the value.

## License

MIT
