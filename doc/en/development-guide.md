# Development guide

## Build

Install dependencies and build the ESM package:

<pre><code>npm install
npm run build
npm run typecheck:examples</code></pre>

The package uses strict TypeScript, NodeNext module resolution, and declaration output. Build copies the YAML signal catalog beside the compiled modules so installed packages can load it.

## Signal definitions

The three files under `src/config` define supported attributes, metrics, workflow and agent events, A2A operations, and A2A-T extensions. Keep these files aligned with the Java and Python SDKs. When a public signal changes, update the applicable configuration version and both language API references and guides. Treat removing or tightening a published signal, attribute, required field, or metric dimension as a breaking change.

A2A spans use the Java SDK operation names, including `SendMessage`, `SendStreamingMessage`, and the `GetTask` / push-notification methods. `GetExtendedAgentCard` and `SendPushNotification` are client-only; `SendStreamingMessage-negotiation` is server-only. Stream-event and stream-error spans retain their parent as a link.

## Exporters and context

The SDK owns trace, metric, and log providers and does not replace the application's global tracer, meter, or logger providers. It installs the OpenTelemetry asynchronous context manager only when no context manager is already registered. Runtime exporter replacement retains in-flight requests and shuts down each retired exporter after those requests complete.

## Commits and pull requests

- Use Conventional Commit messages, such as `feat(sdk): add TypeScript observability SDK`.
- Sign commits off with DCO: `git commit -s -m "..."`.
- Submit pull requests from a personal fork; do not push commits directly to the upstream repository.
- Write pull request titles and descriptions in English and include the verification performed.
