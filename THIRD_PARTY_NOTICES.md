# Third-party notices

<!-- Generated from package-lock.json and node_modules by `npm run notices`. Do not edit by hand. -->

Maxx is licensed under the Apache License 2.0 (see [LICENSE](LICENSE)). It depends on the
third-party packages below, each under its own license. This list covers production dependencies:
packages in `package-lock.json` that npm does not mark as development-only. Platform-specific
optional packages are listed even though only the one matching your system is installed.

Files vendored into the repository are listed in the README: `docs/meta-knowledge/` (MIT) and
`src/app/vendor/shadcn-tailwind.css` (MIT).

624 packages. Licenses:

| License | Packages |
|---|---:|
| MIT | 416 |
| Apache-2.0 | 114 |
| ISC | 31 |
| BSD-3-Clause | 17 |
| BlueOak-1.0.0 | 12 |
| LGPL-3.0-or-later | 10 |
| FSL-1.1-MIT | 9 |
| BSD-2-Clause | 4 |
| Apache-2.0 AND LGPL-3.0-or-later | 3 |
| 0BSD | 2 |
| (MIT OR CC0-1.0) | 1 |
| Apache-2.0 AND LGPL-3.0-or-later AND MIT | 1 |
| CC-BY-4.0 | 1 |
| MIT AND ISC | 1 |
| MIT-0 | 1 |
| Unlicense | 1 |

## Anthropic SDK family (Apache-2.0)

Maxx calls Claude through the Anthropic SDK family. These versions are licensed under the Apache
License, Version 2.0. Earlier versions were published under the MIT License, as each package's
`LICENSE-MIT` file records.

- `@anthropic-ai/bedrock-sdk` 1.1.0: Apache-2.0. Copyright 2023 Anthropic, PBC.
- `@anthropic-ai/foundry-sdk` 1.1.0: Apache-2.0. Copyright 2023 Anthropic, PBC.
- `@anthropic-ai/sdk` 1.3.0: Apache-2.0. Copyright 2023 Anthropic, PBC.
- `@anthropic-ai/vertex-sdk` 1.1.0: Apache-2.0. Copyright 2023 Anthropic, PBC.

```
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## NOTICE files

Reproduced as Apache-2.0 section 4(d) requires.

### import-in-the-middle 3.6.0

```
import-in-the-middle is licensed for use as follows:

Copyright 2024 Node.js contributors. All rights reserved.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

This license applies to parts of import-in-the-middle originating from the
https://github.com/DataDog/import-in-the-middle repository:

    This product includes software developed at Datadog (https://www.datadoghq.com/).

    Copyright 2021 Datadog, Inc.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
```

## Licenses that need attention

Not plain permissive licenses. Read each before redistributing a build.

| Package | Version | License | Note |
|---|---|---|---|
| `@img/sharp-libvips-darwin-arm64` | 1.3.4 | LGPL-3.0-or-later | optional, platform-specific |
| `@img/sharp-libvips-darwin-x64` | 1.3.4 | LGPL-3.0-or-later | optional, platform-specific |
| `@img/sharp-libvips-linux-arm` | 1.3.4 | LGPL-3.0-or-later | optional, platform-specific |
| `@img/sharp-libvips-linux-arm64` | 1.3.4 | LGPL-3.0-or-later | optional, platform-specific |
| `@img/sharp-libvips-linux-ppc64` | 1.3.4 | LGPL-3.0-or-later | optional, platform-specific |
| `@img/sharp-libvips-linux-riscv64` | 1.3.4 | LGPL-3.0-or-later | optional, platform-specific |
| `@img/sharp-libvips-linux-s390x` | 1.3.4 | LGPL-3.0-or-later | optional, platform-specific |
| `@img/sharp-libvips-linux-x64` | 1.3.4 | LGPL-3.0-or-later | optional, platform-specific |
| `@img/sharp-libvips-linuxmusl-arm64` | 1.3.4 | LGPL-3.0-or-later | optional, platform-specific |
| `@img/sharp-libvips-linuxmusl-x64` | 1.3.4 | LGPL-3.0-or-later | optional, platform-specific |
| `@img/sharp-wasm32` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT | optional, platform-specific |
| `@img/sharp-win32-arm64` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | optional, platform-specific |
| `@img/sharp-win32-ia32` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | optional, platform-specific |
| `@img/sharp-win32-x64` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later | optional, platform-specific |
| `@sentry/cli` | 2.58.6 | FSL-1.1-MIT |  |
| `@sentry/cli-darwin` | 2.58.6 | FSL-1.1-MIT | optional, platform-specific |
| `@sentry/cli-linux-arm` | 2.58.6 | FSL-1.1-MIT | optional, platform-specific |
| `@sentry/cli-linux-arm64` | 2.58.6 | FSL-1.1-MIT | optional, platform-specific |
| `@sentry/cli-linux-i686` | 2.58.6 | FSL-1.1-MIT | optional, platform-specific |
| `@sentry/cli-linux-x64` | 2.58.6 | FSL-1.1-MIT | optional, platform-specific |
| `@sentry/cli-win32-arm64` | 2.58.6 | FSL-1.1-MIT | optional, platform-specific |
| `@sentry/cli-win32-i686` | 2.58.6 | FSL-1.1-MIT | optional, platform-specific |
| `@sentry/cli-win32-x64` | 2.58.6 | FSL-1.1-MIT | optional, platform-specific |
| `caniuse-lite` | 1.0.30001818 | CC-BY-4.0 |  |
| `fast-sha256` | 1.3.0 | Unlicense |  |

## All production dependencies

| Package | Version | License |
|---|---|---|
| `@anthropic-ai/bedrock-sdk` | 1.1.0 | Apache-2.0 |
| `@anthropic-ai/foundry-sdk` | 1.1.0 | Apache-2.0 |
| `@anthropic-ai/sdk` | 1.3.0 | Apache-2.0 |
| `@anthropic-ai/vertex-sdk` | 1.1.0 | Apache-2.0 |
| `@aws-crypto/crc32` | 3.0.0 | Apache-2.0 |
| `@aws-crypto/sha256-js` | 4.0.0 | Apache-2.0 |
| `@aws-crypto/util` | 3.0.0 | Apache-2.0 |
| `@aws-crypto/util` | 4.0.0 | Apache-2.0 |
| `@aws-sdk/client-bedrock-runtime` | 3.1156.0 | Apache-2.0 |
| `@aws-sdk/core` | 3.978.5 | Apache-2.0 |
| `@aws-sdk/credential-provider-cognito-identity` | 3.972.75 | Apache-2.0 |
| `@aws-sdk/credential-provider-env` | 3.972.76 | Apache-2.0 |
| `@aws-sdk/credential-provider-http` | 3.972.78 | Apache-2.0 |
| `@aws-sdk/credential-provider-ini` | 3.973.21 | Apache-2.0 |
| `@aws-sdk/credential-provider-login` | 3.972.83 | Apache-2.0 |
| `@aws-sdk/credential-provider-node` | 3.972.88 | Apache-2.0 |
| `@aws-sdk/credential-provider-process` | 3.972.76 | Apache-2.0 |
| `@aws-sdk/credential-provider-sso` | 3.973.20 | Apache-2.0 |
| `@aws-sdk/credential-provider-web-identity` | 3.972.82 | Apache-2.0 |
| `@aws-sdk/credential-providers` | 3.1156.0 | Apache-2.0 |
| `@aws-sdk/eventstream-handler-node` | 3.972.38 | Apache-2.0 |
| `@aws-sdk/middleware-eventstream` | 3.972.33 | Apache-2.0 |
| `@aws-sdk/middleware-websocket` | 3.972.58 | Apache-2.0 |
| `@aws-sdk/nested-clients` | 3.997.50 | Apache-2.0 |
| `@aws-sdk/signature-v4-multi-region` | 3.996.49 | Apache-2.0 |
| `@aws-sdk/token-providers` | 3.1155.0 | Apache-2.0 |
| `@aws-sdk/token-providers` | 3.1156.0 | Apache-2.0 |
| `@aws-sdk/types` | 3.975.0 | Apache-2.0 |
| `@aws-sdk/util-utf8-browser` | 3.259.0 | Apache-2.0 |
| `@aws-sdk/xml-builder` | 3.972.41 | Apache-2.0 |
| `@aws/lambda-invoke-store` | 0.3.0 | Apache-2.0 |
| `@babel/code-frame` | 7.29.7 | MIT |
| `@babel/compat-data` | 7.29.7 | MIT |
| `@babel/core` | 7.29.7 | MIT |
| `@babel/generator` | 7.29.7 | MIT |
| `@babel/helper-compilation-targets` | 7.29.7 | MIT |
| `@babel/helper-globals` | 7.29.7 | MIT |
| `@babel/helper-module-imports` | 7.29.7 | MIT |
| `@babel/helper-module-transforms` | 7.29.7 | MIT |
| `@babel/helper-string-parser` | 7.29.7 | MIT |
| `@babel/helper-validator-identifier` | 7.29.7 | MIT |
| `@babel/helper-validator-option` | 7.29.7 | MIT |
| `@babel/helpers` | 7.29.7 | MIT |
| `@babel/parser` | 7.29.7 | MIT |
| `@babel/runtime` | 7.29.2 | MIT |
| `@babel/runtime` | 8.0.8 | MIT |
| `@babel/template` | 7.29.7 | MIT |
| `@babel/traverse` | 7.29.7 | MIT |
| `@babel/types` | 7.29.7 | MIT |
| `@base-ui/react` | 1.9.0 | MIT |
| `@base-ui/utils` | 0.5.0 | MIT |
| `@date-fns/tz` | 1.4.1 | MIT |
| `@emnapi/runtime` | 1.11.3 | MIT (optional) |
| `@floating-ui/core` | 1.8.0 | MIT |
| `@floating-ui/dom` | 1.8.0 | MIT |
| `@floating-ui/react-dom` | 2.1.9 | MIT |
| `@floating-ui/utils` | 0.2.12 | MIT |
| `@google-analytics/data` | 7.3.0 | Apache-2.0 |
| `@grpc/grpc-js` | 1.14.6 | Apache-2.0 |
| `@grpc/proto-loader` | 0.8.1 | Apache-2.0 |
| `@hono/node-server` | 2.1.6 | MIT |
| `@img/colour` | 1.1.0 | MIT (optional) |
| `@img/sharp-darwin-arm64` | 0.35.5 | Apache-2.0 (optional) |
| `@img/sharp-darwin-x64` | 0.35.5 | Apache-2.0 (optional) |
| `@img/sharp-freebsd-wasm32` | 0.35.5 | Apache-2.0 (optional) |
| `@img/sharp-libvips-darwin-arm64` | 1.3.4 | LGPL-3.0-or-later (optional) |
| `@img/sharp-libvips-darwin-x64` | 1.3.4 | LGPL-3.0-or-later (optional) |
| `@img/sharp-libvips-linux-arm` | 1.3.4 | LGPL-3.0-or-later (optional) |
| `@img/sharp-libvips-linux-arm64` | 1.3.4 | LGPL-3.0-or-later (optional) |
| `@img/sharp-libvips-linux-ppc64` | 1.3.4 | LGPL-3.0-or-later (optional) |
| `@img/sharp-libvips-linux-riscv64` | 1.3.4 | LGPL-3.0-or-later (optional) |
| `@img/sharp-libvips-linux-s390x` | 1.3.4 | LGPL-3.0-or-later (optional) |
| `@img/sharp-libvips-linux-x64` | 1.3.4 | LGPL-3.0-or-later (optional) |
| `@img/sharp-libvips-linuxmusl-arm64` | 1.3.4 | LGPL-3.0-or-later (optional) |
| `@img/sharp-libvips-linuxmusl-x64` | 1.3.4 | LGPL-3.0-or-later (optional) |
| `@img/sharp-linux-arm` | 0.35.5 | Apache-2.0 (optional) |
| `@img/sharp-linux-arm64` | 0.35.5 | Apache-2.0 (optional) |
| `@img/sharp-linux-ppc64` | 0.35.5 | Apache-2.0 (optional) |
| `@img/sharp-linux-riscv64` | 0.35.5 | Apache-2.0 (optional) |
| `@img/sharp-linux-s390x` | 0.35.5 | Apache-2.0 (optional) |
| `@img/sharp-linux-x64` | 0.35.5 | Apache-2.0 (optional) |
| `@img/sharp-linuxmusl-arm64` | 0.35.5 | Apache-2.0 (optional) |
| `@img/sharp-linuxmusl-x64` | 0.35.5 | Apache-2.0 (optional) |
| `@img/sharp-wasm32` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT (optional) |
| `@img/sharp-webcontainers-wasm32` | 0.35.5 | Apache-2.0 (optional) |
| `@img/sharp-win32-arm64` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later (optional) |
| `@img/sharp-win32-ia32` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later (optional) |
| `@img/sharp-win32-x64` | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later (optional) |
| `@isaacs/nonrecursive-glob-match` | 1.1.0 | BlueOak-1.0.0 |
| `@jridgewell/gen-mapping` | 0.3.13 | MIT |
| `@jridgewell/remapping` | 2.3.5 | MIT |
| `@jridgewell/resolve-uri` | 3.1.2 | MIT |
| `@jridgewell/source-map` | 0.3.11 | MIT |
| `@jridgewell/sourcemap-codec` | 1.6.0 | MIT |
| `@jridgewell/trace-mapping` | 0.3.31 | MIT |
| `@js-sdsl/ordered-map` | 4.4.2 | MIT |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT |
| `@next/env` | 16.4.3 | MIT |
| `@next/swc-darwin-arm64` | 16.4.3 | MIT (optional) |
| `@next/swc-darwin-x64` | 16.4.3 | MIT (optional) |
| `@next/swc-linux-arm64-gnu` | 16.4.3 | MIT (optional) |
| `@next/swc-linux-arm64-musl` | 16.4.3 | MIT (optional) |
| `@next/swc-linux-x64-gnu` | 16.4.3 | MIT (optional) |
| `@next/swc-linux-x64-musl` | 16.4.3 | MIT (optional) |
| `@next/swc-win32-arm64-msvc` | 16.4.3 | MIT (optional) |
| `@next/swc-win32-x64-msvc` | 16.4.3 | MIT (optional) |
| `@opentelemetry/api` | 1.9.1 | Apache-2.0 |
| `@opentelemetry/api-logs` | 0.220.0 | Apache-2.0 |
| `@opentelemetry/core` | 2.12.0 | Apache-2.0 |
| `@opentelemetry/instrumentation` | 0.220.0 | Apache-2.0 |
| `@opentelemetry/resources` | 2.12.0 | Apache-2.0 |
| `@opentelemetry/sdk-trace` | 2.12.0 | Apache-2.0 |
| `@opentelemetry/sdk-trace-base` | 2.12.0 | Apache-2.0 |
| `@opentelemetry/semantic-conventions` | 1.45.0 | Apache-2.0 |
| `@protobufjs/aspromise` | 1.1.2 | BSD-3-Clause |
| `@protobufjs/base64` | 1.1.2 | BSD-3-Clause |
| `@protobufjs/codegen` | 2.0.5 | BSD-3-Clause |
| `@protobufjs/eventemitter` | 1.1.1 | BSD-3-Clause |
| `@protobufjs/fetch` | 1.1.1 | BSD-3-Clause |
| `@protobufjs/float` | 1.0.2 | BSD-3-Clause |
| `@protobufjs/path` | 1.1.2 | BSD-3-Clause |
| `@protobufjs/pool` | 1.1.0 | BSD-3-Clause |
| `@protobufjs/utf8` | 1.1.2 | BSD-3-Clause |
| `@reduxjs/toolkit` | 2.11.2 | MIT |
| `@rollup/plugin-commonjs` | 28.0.1 | MIT |
| `@rollup/pluginutils` | 5.4.0 | MIT |
| `@rollup/rollup-android-arm-eabi` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-android-arm64` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-darwin-arm64` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-darwin-x64` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-freebsd-arm64` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-freebsd-x64` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-linux-arm-gnueabihf` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-linux-arm-musleabihf` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-linux-arm64-gnu` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-linux-arm64-musl` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-linux-loong64-gnu` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-linux-loong64-musl` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-linux-ppc64-gnu` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-linux-ppc64-musl` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-linux-riscv64-gnu` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-linux-riscv64-musl` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-linux-s390x-gnu` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-linux-x64-gnu` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-linux-x64-musl` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-openbsd-x64` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-openharmony-arm64` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-win32-arm64-msvc` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-win32-ia32-msvc` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-win32-x64-gnu` | 4.62.2 | MIT (optional) |
| `@rollup/rollup-win32-x64-msvc` | 4.62.2 | MIT (optional) |
| `@sentry/browser` | 10.76.2 | MIT |
| `@sentry/browser-utils` | 10.76.2 | MIT |
| `@sentry/bundler-plugins` | 10.76.2 | MIT |
| `@sentry/bundler-plugins` | 10.78.0 | MIT |
| `@sentry/cli` | 2.58.6 | FSL-1.1-MIT |
| `@sentry/cli-darwin` | 2.58.6 | FSL-1.1-MIT (optional) |
| `@sentry/cli-linux-arm` | 2.58.6 | FSL-1.1-MIT (optional) |
| `@sentry/cli-linux-arm64` | 2.58.6 | FSL-1.1-MIT (optional) |
| `@sentry/cli-linux-i686` | 2.58.6 | FSL-1.1-MIT (optional) |
| `@sentry/cli-linux-x64` | 2.58.6 | FSL-1.1-MIT (optional) |
| `@sentry/cli-win32-arm64` | 2.58.6 | FSL-1.1-MIT (optional) |
| `@sentry/cli-win32-i686` | 2.58.6 | FSL-1.1-MIT (optional) |
| `@sentry/cli-win32-x64` | 2.58.6 | FSL-1.1-MIT (optional) |
| `@sentry/conventions` | 0.16.0 | MIT |
| `@sentry/core` | 10.76.2 | MIT |
| `@sentry/core` | 10.78.0 | MIT |
| `@sentry/feedback` | 10.76.2 | MIT |
| `@sentry/nextjs` | 10.76.2 | MIT |
| `@sentry/node` | 10.76.2 | MIT |
| `@sentry/node-core` | 10.76.2 | MIT |
| `@sentry/opentelemetry` | 10.76.2 | MIT |
| `@sentry/react` | 10.76.2 | MIT |
| `@sentry/replay` | 10.76.2 | MIT |
| `@sentry/replay-canvas` | 10.76.2 | MIT |
| `@sentry/server-utils` | 10.76.2 | MIT |
| `@sentry/vercel-edge` | 10.76.2 | MIT |
| `@sentry/webpack-plugin` | 5.4.1 | MIT |
| `@smithy/abort-controller` | 2.2.0 | Apache-2.0 |
| `@smithy/core` | 3.36.2 | Apache-2.0 |
| `@smithy/credential-provider-imds` | 4.5.2 | Apache-2.0 |
| `@smithy/eventstream-codec` | 2.2.0 | Apache-2.0 |
| `@smithy/eventstream-serde-node` | 2.2.0 | Apache-2.0 |
| `@smithy/eventstream-serde-universal` | 2.2.0 | Apache-2.0 |
| `@smithy/fetch-http-handler` | 2.5.0 | Apache-2.0 |
| `@smithy/fetch-http-handler` | 5.8.0 | Apache-2.0 |
| `@smithy/is-array-buffer` | 2.2.0 | Apache-2.0 |
| `@smithy/is-array-buffer` | 3.0.0 | Apache-2.0 |
| `@smithy/middleware-endpoint` | 2.5.1 | Apache-2.0 |
| `@smithy/middleware-serde` | 2.3.0 | Apache-2.0 |
| `@smithy/middleware-stack` | 2.2.0 | Apache-2.0 |
| `@smithy/node-config-provider` | 2.3.0 | Apache-2.0 |
| `@smithy/node-http-handler` | 2.5.0 | Apache-2.0 |
| `@smithy/node-http-handler` | 4.12.1 | Apache-2.0 |
| `@smithy/property-provider` | 2.2.0 | Apache-2.0 |
| `@smithy/protocol-http` | 3.3.0 | Apache-2.0 |
| `@smithy/querystring-builder` | 2.2.0 | Apache-2.0 |
| `@smithy/querystring-parser` | 2.2.0 | Apache-2.0 |
| `@smithy/shared-ini-file-loader` | 2.4.0 | Apache-2.0 |
| `@smithy/signature-v4` | 3.1.2 | Apache-2.0 |
| `@smithy/signature-v4` | 5.7.4 | Apache-2.0 |
| `@smithy/smithy-client` | 2.5.1 | Apache-2.0 |
| `@smithy/types` | 2.12.0 | Apache-2.0 |
| `@smithy/types` | 3.7.2 | Apache-2.0 |
| `@smithy/types` | 4.19.0 | Apache-2.0 |
| `@smithy/url-parser` | 2.2.0 | Apache-2.0 |
| `@smithy/util-base64` | 2.3.0 | Apache-2.0 |
| `@smithy/util-buffer-from` | 2.2.0 | Apache-2.0 |
| `@smithy/util-buffer-from` | 3.0.0 | Apache-2.0 |
| `@smithy/util-hex-encoding` | 2.2.0 | Apache-2.0 |
| `@smithy/util-hex-encoding` | 3.0.0 | Apache-2.0 |
| `@smithy/util-middleware` | 2.2.0 | Apache-2.0 |
| `@smithy/util-middleware` | 3.0.11 | Apache-2.0 |
| `@smithy/util-stream` | 2.2.0 | Apache-2.0 |
| `@smithy/util-uri-escape` | 2.2.0 | Apache-2.0 |
| `@smithy/util-uri-escape` | 3.0.0 | Apache-2.0 |
| `@smithy/util-utf8` | 2.3.0 | Apache-2.0 |
| `@smithy/util-utf8` | 3.0.0 | Apache-2.0 |
| `@stablelib/base64` | 1.0.1 | MIT |
| `@standard-schema/spec` | 1.1.0 | MIT |
| `@standard-schema/utils` | 0.3.0 | MIT |
| `@supabase/auth-js` | 2.118.0 | MIT |
| `@supabase/functions-js` | 2.118.0 | MIT |
| `@supabase/phoenix` | 0.4.5 | MIT |
| `@supabase/postgrest-js` | 2.118.0 | MIT |
| `@supabase/realtime-js` | 2.118.0 | MIT |
| `@supabase/ssr` | 0.12.7 | MIT |
| `@supabase/storage-js` | 2.118.0 | MIT |
| `@supabase/supabase-js` | 2.118.0 | MIT |
| `@swc/helpers` | 0.5.23 | Apache-2.0 |
| `@types/d3-array` | 3.2.2 | MIT |
| `@types/d3-color` | 3.1.3 | MIT |
| `@types/d3-ease` | 3.0.2 | MIT |
| `@types/d3-interpolate` | 3.0.4 | MIT |
| `@types/d3-path` | 3.1.1 | MIT |
| `@types/d3-scale` | 4.0.9 | MIT |
| `@types/d3-shape` | 3.1.8 | MIT |
| `@types/d3-time` | 3.0.4 | MIT |
| `@types/d3-timer` | 3.0.2 | MIT |
| `@types/debug` | 4.1.13 | MIT |
| `@types/estree` | 1.0.9 | MIT |
| `@types/estree-jsx` | 1.0.5 | MIT |
| `@types/hast` | 3.0.4 | MIT |
| `@types/json-schema` | 7.0.15 | MIT |
| `@types/mdast` | 4.0.4 | MIT |
| `@types/ms` | 2.1.0 | MIT |
| `@types/node` | 24.19.2 | MIT |
| `@types/react` | 19.3.0 | MIT |
| `@types/unist` | 2.0.11 | MIT |
| `@types/unist` | 3.0.3 | MIT |
| `@types/use-sync-external-store` | 0.0.6 | MIT |
| `@ungap/structured-clone` | 1.3.1 | ISC |
| `@webassemblyjs/ast` | 1.14.1 | MIT |
| `@webassemblyjs/floating-point-hex-parser` | 1.13.2 | MIT |
| `@webassemblyjs/helper-api-error` | 1.13.2 | MIT |
| `@webassemblyjs/helper-buffer` | 1.14.1 | MIT |
| `@webassemblyjs/helper-numbers` | 1.13.2 | MIT |
| `@webassemblyjs/helper-wasm-bytecode` | 1.13.2 | MIT |
| `@webassemblyjs/helper-wasm-section` | 1.14.1 | MIT |
| `@webassemblyjs/ieee754` | 1.13.2 | MIT |
| `@webassemblyjs/leb128` | 1.13.2 | Apache-2.0 |
| `@webassemblyjs/utf8` | 1.13.2 | MIT |
| `@webassemblyjs/wasm-edit` | 1.14.1 | MIT |
| `@webassemblyjs/wasm-gen` | 1.14.1 | MIT |
| `@webassemblyjs/wasm-opt` | 1.14.1 | MIT |
| `@webassemblyjs/wasm-parser` | 1.14.1 | MIT |
| `@webassemblyjs/wast-printer` | 1.14.1 | MIT |
| `@xtuc/ieee754` | 1.2.0 | BSD-3-Clause |
| `@xtuc/long` | 4.2.2 | Apache-2.0 |
| `accepts` | 2.0.0 | MIT |
| `acorn` | 8.16.0 | MIT |
| `agent-base` | 6.0.2 | MIT |
| `agent-base` | 7.1.4 | MIT |
| `ajv` | 8.20.0 | MIT |
| `ajv-formats` | 3.0.1 | MIT |
| `ajv-keywords` | 5.1.0 | MIT |
| `ansi-regex` | 5.0.1 | MIT |
| `ansi-styles` | 4.3.0 | MIT |
| `bail` | 2.0.2 | MIT |
| `balanced-match` | 4.0.4 | MIT |
| `base64-js` | 1.5.1 | MIT |
| `baseline-browser-mapping` | 2.11.30 | Apache-2.0 |
| `bignumber.js` | 9.3.1 | MIT |
| `body-parser` | 2.4.0 | MIT |
| `bowser` | 2.14.1 | MIT |
| `brace-expansion` | 5.0.12 | MIT |
| `browserslist` | 4.29.4 | MIT |
| `buffer-equal-constant-time` | 1.0.1 | BSD-3-Clause |
| `buffer-from` | 1.1.2 | MIT |
| `bytes` | 3.1.2 | MIT |
| `call-bind-apply-helpers` | 1.0.2 | MIT |
| `call-bound` | 1.0.4 | MIT |
| `caniuse-lite` | 1.0.30001818 | CC-BY-4.0 |
| `ccount` | 2.0.1 | MIT |
| `character-entities` | 2.0.2 | MIT |
| `character-entities-html4` | 2.1.0 | MIT |
| `character-entities-legacy` | 3.0.0 | MIT |
| `character-reference-invalid` | 2.0.1 | MIT |
| `chrome-trace-event` | 1.0.4 | MIT |
| `cjs-module-lexer` | 2.3.0 | MIT |
| `class-variance-authority` | 0.7.1 | Apache-2.0 |
| `client-only` | 0.0.1 | MIT |
| `cliui` | 8.0.1 | ISC |
| `clsx` | 2.1.1 | MIT |
| `color-convert` | 2.0.1 | MIT |
| `color-name` | 1.1.4 | MIT |
| `comma-separated-tokens` | 2.0.3 | MIT |
| `commander` | 2.20.3 | MIT |
| `commondir` | 1.0.1 | MIT |
| `content-disposition` | 1.1.0 | MIT |
| `content-type` | 1.0.5 | MIT |
| `content-type` | 2.0.0 | MIT |
| `content-type` | 2.1.0 | MIT |
| `convert-source-map` | 2.0.0 | MIT |
| `cookie` | 0.7.2 | MIT |
| `cookie` | 1.1.1 | MIT |
| `cookie-signature` | 1.2.2 | MIT |
| `cors` | 2.8.6 | MIT |
| `cross-spawn` | 7.0.6 | MIT |
| `csstype` | 3.2.3 | MIT |
| `d3-array` | 3.2.4 | ISC |
| `d3-color` | 3.1.0 | ISC |
| `d3-ease` | 3.0.1 | BSD-3-Clause |
| `d3-format` | 3.1.2 | ISC |
| `d3-interpolate` | 3.0.1 | ISC |
| `d3-path` | 3.1.0 | ISC |
| `d3-scale` | 4.0.2 | ISC |
| `d3-shape` | 3.2.0 | ISC |
| `d3-time` | 3.1.0 | ISC |
| `d3-time-format` | 4.1.0 | ISC |
| `d3-timer` | 3.0.1 | ISC |
| `data-uri-to-buffer` | 4.0.1 | MIT |
| `date-fns` | 4.4.0 | MIT |
| `debug` | 4.4.3 | MIT |
| `decimal.js-light` | 2.5.1 | MIT |
| `decode-named-character-reference` | 1.3.0 | MIT |
| `depd` | 2.0.0 | MIT |
| `dequal` | 2.0.3 | MIT |
| `devlop` | 1.1.0 | MIT |
| `dotenv` | 17.4.2 | BSD-2-Clause |
| `dunder-proto` | 1.0.1 | MIT |
| `duplexify` | 4.1.3 | MIT |
| `ecdsa-sig-formatter` | 1.0.11 | Apache-2.0 |
| `ee-first` | 1.1.1 | MIT |
| `electron-to-chromium` | 1.5.463 | ISC |
| `emoji-regex` | 8.0.0 | MIT |
| `encodeurl` | 2.0.0 | MIT |
| `end-of-stream` | 1.4.5 | MIT |
| `enhanced-resolve` | 5.26.1 | MIT |
| `es-define-property` | 1.0.1 | MIT |
| `es-errors` | 1.3.0 | MIT |
| `es-module-lexer` | 2.3.2 | MIT |
| `es-module-lexer` | 3.0.4 | MIT |
| `es-object-atoms` | 1.1.2 | MIT |
| `es-toolkit` | 1.46.1 | MIT |
| `escalade` | 3.2.0 | MIT |
| `escape-html` | 1.0.3 | MIT |
| `estree-util-is-identifier-name` | 3.0.0 | MIT |
| `estree-walker` | 2.0.2 | MIT |
| `etag` | 1.8.1 | MIT |
| `eventemitter3` | 5.0.4 | MIT |
| `events` | 3.3.0 | MIT |
| `eventsource` | 3.0.7 | MIT |
| `eventsource-parser` | 3.0.8 | MIT |
| `express` | 5.2.1 | MIT |
| `express-rate-limit` | 8.5.2 | MIT |
| `extend` | 3.0.2 | MIT |
| `fast-deep-equal` | 3.1.3 | MIT |
| `fast-sha256` | 1.3.0 | Unlicense |
| `fast-uri` | 3.1.9 | BSD-3-Clause |
| `fdir` | 6.5.0 | MIT |
| `fetch-blob` | 3.2.0 | MIT |
| `finalhandler` | 2.1.1 | MIT |
| `find-up` | 5.0.0 | MIT |
| `formdata-polyfill` | 4.0.10 | MIT |
| `forwarded` | 0.2.0 | MIT |
| `fresh` | 2.0.0 | MIT |
| `fsevents` | 2.3.3 | MIT (optional) |
| `function-bind` | 1.1.2 | MIT |
| `gaxios` | 7.1.3 | Apache-2.0 |
| `gaxios` | 7.1.5 | Apache-2.0 |
| `gaxios` | 8.3.2 | Apache-2.0 |
| `gcp-metadata` | 8.1.3 | Apache-2.0 |
| `gcp-metadata` | 9.2.2 | Apache-2.0 |
| `gensync` | 1.0.0-beta.2 | MIT |
| `get-caller-file` | 2.0.5 | ISC |
| `get-intrinsic` | 1.3.0 | MIT |
| `get-proto` | 1.0.1 | MIT |
| `glob` | 13.0.6 | BlueOak-1.0.0 |
| `glob` | 14.0.4 | BlueOak-1.0.0 |
| `google-auth-library` | 10.5.0 | Apache-2.0 |
| `google-auth-library` | 11.3.1 | Apache-2.0 |
| `google-gax` | 6.13.0 | Apache-2.0 |
| `google-logging-utils` | 1.1.3 | Apache-2.0 |
| `google-logging-utils` | 2.1.0 | Apache-2.0 |
| `gopd` | 1.2.0 | MIT |
| `graceful-fs` | 4.2.11 | ISC |
| `gtoken` | 8.0.0 | MIT |
| `has-flag` | 4.0.0 | MIT |
| `has-symbols` | 1.1.0 | MIT |
| `hasown` | 2.0.3 | MIT |
| `hast-util-to-jsx-runtime` | 2.3.6 | MIT |
| `hast-util-whitespace` | 3.0.0 | MIT |
| `hono` | 4.13.13 | MIT |
| `html-url-attributes` | 3.0.1 | MIT |
| `http-errors` | 2.0.1 | MIT |
| `https-proxy-agent` | 5.0.1 | MIT |
| `https-proxy-agent` | 7.0.6 | MIT |
| `iceberg-js` | 0.8.1 | MIT |
| `iconv-lite` | 0.7.3 | MIT |
| `immer` | 11.2.9 | MIT |
| `import-in-the-middle` | 3.6.0 | Apache-2.0 |
| `inherits` | 2.0.4 | ISC |
| `inline-style-parser` | 0.2.7 | MIT |
| `internmap` | 2.0.3 | ISC |
| `ip-address` | 10.7.4 | MIT |
| `ipaddr.js` | 1.9.1 | MIT |
| `is-alphabetical` | 2.0.1 | MIT |
| `is-alphanumerical` | 2.0.1 | MIT |
| `is-decimal` | 2.0.1 | MIT |
| `is-fullwidth-code-point` | 3.0.0 | MIT |
| `is-hexadecimal` | 2.0.1 | MIT |
| `is-plain-obj` | 4.1.0 | MIT |
| `is-promise` | 4.0.0 | MIT |
| `is-reference` | 1.2.1 | MIT |
| `isexe` | 2.0.0 | ISC |
| `jest-worker` | 27.5.1 | MIT |
| `jose` | 6.2.3 | MIT |
| `js-tokens` | 4.0.0 | MIT |
| `jsesc` | 3.1.0 | MIT |
| `json-bigint` | 1.0.0 | MIT |
| `json-schema-to-ts` | 3.1.1 | MIT |
| `json-schema-traverse` | 1.0.0 | MIT |
| `json-schema-typed` | 8.0.2 | BSD-2-Clause |
| `json5` | 2.2.3 | MIT |
| `jwa` | 2.0.1 | MIT |
| `jws` | 4.0.1 | MIT |
| `locate-path` | 6.0.0 | MIT |
| `lodash.camelcase` | 4.3.0 | MIT |
| `long` | 5.3.2 | Apache-2.0 |
| `longest-streak` | 3.1.0 | MIT |
| `lru-cache` | 11.5.1 | BlueOak-1.0.0 |
| `lru-cache` | 11.5.3 | BlueOak-1.0.0 |
| `lru-cache` | 5.1.1 | ISC |
| `lucide-react` | 1.62.0 | ISC |
| `magic-string` | 0.30.21 | MIT |
| `math-intrinsics` | 1.1.0 | MIT |
| `mdast-util-from-markdown` | 2.0.3 | MIT |
| `mdast-util-mdx-expression` | 2.0.1 | MIT |
| `mdast-util-mdx-jsx` | 3.2.0 | MIT |
| `mdast-util-mdxjs-esm` | 2.0.1 | MIT |
| `mdast-util-phrasing` | 4.1.0 | MIT |
| `mdast-util-to-hast` | 13.2.1 | MIT |
| `mdast-util-to-markdown` | 2.1.2 | MIT |
| `mdast-util-to-string` | 4.0.0 | MIT |
| `media-typer` | 1.1.0 | MIT |
| `merge-descriptors` | 2.0.0 | MIT |
| `merge-stream` | 2.0.0 | MIT |
| `micromark` | 4.0.2 | MIT |
| `micromark-core-commonmark` | 2.0.3 | MIT |
| `micromark-factory-destination` | 2.0.1 | MIT |
| `micromark-factory-label` | 2.0.1 | MIT |
| `micromark-factory-space` | 2.0.1 | MIT |
| `micromark-factory-title` | 2.0.1 | MIT |
| `micromark-factory-whitespace` | 2.0.1 | MIT |
| `micromark-util-character` | 2.1.1 | MIT |
| `micromark-util-chunked` | 2.0.1 | MIT |
| `micromark-util-classify-character` | 2.0.1 | MIT |
| `micromark-util-combine-extensions` | 2.0.1 | MIT |
| `micromark-util-decode-numeric-character-reference` | 2.0.2 | MIT |
| `micromark-util-decode-string` | 2.0.1 | MIT |
| `micromark-util-encode` | 2.0.1 | MIT |
| `micromark-util-html-tag-name` | 2.0.1 | MIT |
| `micromark-util-normalize-identifier` | 2.0.1 | MIT |
| `micromark-util-resolve-all` | 2.0.1 | MIT |
| `micromark-util-sanitize-uri` | 2.0.1 | MIT |
| `micromark-util-subtokenize` | 2.1.0 | MIT |
| `micromark-util-symbol` | 2.0.1 | MIT |
| `micromark-util-types` | 2.0.2 | MIT |
| `mime-db` | 1.54.0 | MIT |
| `mime-types` | 3.0.2 | MIT |
| `minimatch` | 10.2.6 | BlueOak-1.0.0 |
| `minimatch` | 11.0.5 | BlueOak-1.0.0 |
| `minimizer-webpack-plugin` | 5.14.0 | MIT |
| `minipass` | 7.1.3 | BlueOak-1.0.0 |
| `module-details-from-path` | 1.0.4 | MIT |
| `ms` | 2.1.3 | MIT |
| `nanoid` | 3.3.18 | MIT |
| `negotiator` | 1.0.0 | MIT |
| `next` | 16.4.3 | MIT |
| `next-themes` | 0.4.6 | MIT |
| `node-domexception` | 1.0.0 | MIT |
| `node-fetch` | 2.7.0 | MIT |
| `node-fetch` | 3.3.2 | MIT |
| `node-releases` | 2.0.59 | MIT |
| `nodemailer` | 10.2.1 | MIT-0 |
| `object-assign` | 4.1.1 | MIT |
| `object-hash` | 3.0.0 | MIT |
| `object-inspect` | 1.13.4 | MIT |
| `on-finished` | 2.4.1 | MIT |
| `once` | 1.4.0 | ISC |
| `p-limit` | 3.1.0 | MIT |
| `p-locate` | 5.0.0 | MIT |
| `package-json-from-dist` | 1.0.1 | BlueOak-1.0.0 |
| `parse-entities` | 4.0.2 | MIT |
| `parseurl` | 1.3.3 | MIT |
| `path-exists` | 4.0.0 | MIT |
| `path-key` | 3.1.1 | MIT |
| `path-scurry` | 2.0.2 | BlueOak-1.0.0 |
| `path-scurry` | 3.0.0 | BlueOak-1.0.0 |
| `path-to-regexp` | 8.4.2 | MIT |
| `picocolors` | 1.1.1 | ISC |
| `picomatch` | 4.0.4 | MIT |
| `pkce-challenge` | 5.0.1 | MIT |
| `postcss` | 8.5.25 | MIT |
| `progress` | 2.0.3 | MIT |
| `property-information` | 7.1.0 | MIT |
| `proto3-json-serializer` | 4.1.0 | Apache-2.0 |
| `protobufjs` | 7.6.6 | BSD-3-Clause |
| `proxy-addr` | 2.0.8 | MIT |
| `proxy-from-env` | 1.1.0 | MIT |
| `qs` | 6.16.1 | BSD-3-Clause |
| `range-parser` | 1.2.1 | MIT |
| `raw-body` | 3.0.2 | MIT |
| `react` | 19.3.1 | MIT |
| `react-day-picker` | 10.0.2 | MIT |
| `react-dom` | 19.3.1 | MIT |
| `react-is` | 16.13.1 | MIT |
| `react-markdown` | 10.1.0 | MIT |
| `react-redux` | 9.2.0 | MIT |
| `readable-stream` | 3.6.2 | MIT |
| `recharts` | 3.10.1 | MIT |
| `redux` | 5.0.1 | MIT |
| `redux-thunk` | 3.1.0 | MIT |
| `remark-parse` | 11.0.0 | MIT |
| `remark-rehype` | 11.1.2 | MIT |
| `require-directory` | 2.1.1 | MIT |
| `require-from-string` | 2.0.2 | MIT |
| `require-in-the-middle` | 8.0.1 | MIT |
| `reselect` | 5.2.0 | MIT |
| `reselect` | 5.3.0 | MIT |
| `retry-request` | 9.1.0 | MIT |
| `rimraf` | 6.1.4 | BlueOak-1.0.0 |
| `rollup` | 4.62.2 | MIT |
| `router` | 2.2.0 | MIT |
| `safe-buffer` | 5.2.1 | MIT |
| `safer-buffer` | 2.1.2 | MIT |
| `scheduler` | 0.28.0 | MIT |
| `schema-utils` | 4.8.3 | MIT |
| `semver` | 6.3.1 | ISC |
| `semver` | 7.8.5 | ISC (optional) |
| `send` | 1.2.1 | MIT |
| `serve-static` | 2.2.1 | MIT |
| `setprototypeof` | 1.2.0 | ISC |
| `sharp` | 0.35.5 | Apache-2.0 (optional) |
| `shebang-command` | 2.0.0 | MIT |
| `shebang-regex` | 3.0.0 | MIT |
| `side-channel` | 1.1.1 | MIT |
| `side-channel-list` | 1.0.1 | MIT |
| `side-channel-map` | 1.0.1 | MIT |
| `side-channel-weakmap` | 1.0.2 | MIT |
| `sonner` | 2.0.8 | MIT |
| `source-map` | 0.6.1 | BSD-3-Clause |
| `source-map-js` | 1.2.2 | BSD-3-Clause |
| `source-map-support` | 0.5.21 | MIT |
| `space-separated-tokens` | 2.0.2 | MIT |
| `stacktrace-parser` | 0.1.11 | MIT |
| `standardwebhooks` | 1.0.0 | MIT |
| `statuses` | 2.0.2 | MIT |
| `stream-shift` | 1.0.3 | MIT |
| `string_decoder` | 1.3.0 | MIT |
| `string-width` | 4.2.3 | MIT |
| `stringify-entities` | 4.0.4 | MIT |
| `strip-ansi` | 6.0.1 | MIT |
| `style-to-js` | 1.1.21 | MIT |
| `style-to-object` | 1.0.14 | MIT |
| `styled-jsx` | 5.1.6 | MIT |
| `supports-color` | 8.1.1 | MIT |
| `tailwind-merge` | 3.7.0 | MIT |
| `tapable` | 2.3.3 | MIT |
| `terser` | 5.51.2 | BSD-2-Clause |
| `tiny-invariant` | 1.3.3 | MIT |
| `toidentifier` | 1.0.1 | MIT |
| `tr46` | 0.0.3 | MIT |
| `trim-lines` | 3.0.1 | MIT |
| `trough` | 2.2.0 | MIT |
| `ts-algebra` | 2.0.0 | MIT |
| `tslib` | 1.14.1 | 0BSD |
| `tslib` | 2.8.1 | 0BSD |
| `tw-animate-css` | 1.4.0 | MIT |
| `type-fest` | 0.7.1 | (MIT OR CC0-1.0) |
| `type-is` | 2.1.0 | MIT |
| `undici-types` | 7.24.6 | MIT |
| `unified` | 11.0.5 | MIT |
| `unist-util-is` | 6.0.1 | MIT |
| `unist-util-position` | 5.0.0 | MIT |
| `unist-util-stringify-position` | 4.0.0 | MIT |
| `unist-util-visit` | 5.1.0 | MIT |
| `unist-util-visit-parents` | 6.0.2 | MIT |
| `unpipe` | 1.0.0 | MIT |
| `update-browserslist-db` | 1.3.4 | MIT |
| `use-sync-external-store` | 1.7.0 | MIT |
| `util-deprecate` | 1.0.2 | MIT |
| `vary` | 1.1.2 | MIT |
| `vfile` | 6.0.3 | MIT |
| `vfile-message` | 4.0.3 | MIT |
| `victory-vendor` | 37.3.6 | MIT AND ISC |
| `watchpack` | 2.6.3 | MIT |
| `web-streams-polyfill` | 3.3.3 | MIT |
| `webidl-conversions` | 3.0.1 | BSD-2-Clause |
| `webpack` | 5.112.2 | MIT |
| `webpack-sources` | 3.7.0 | MIT |
| `whatwg-url` | 5.0.0 | MIT |
| `which` | 2.0.2 | ISC |
| `wrap-ansi` | 7.0.0 | MIT |
| `wrappy` | 1.0.2 | ISC |
| `y18n` | 5.0.8 | ISC |
| `yallist` | 3.1.1 | ISC |
| `yargs` | 17.7.3 | MIT |
| `yargs-parser` | 21.1.1 | ISC |
| `yocto-queue` | 0.1.0 | MIT |
| `zod` | 4.6.7 | MIT |
| `zod-to-json-schema` | 3.25.2 | ISC |
| `zwitch` | 2.0.4 | MIT |
