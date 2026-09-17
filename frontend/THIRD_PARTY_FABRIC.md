# Fabric.js compatibility adapter

`src/lib/fabric/runtime.ts` adapts the gradient deserialization compatibility
wrapper from the official `fabric@7.4.0` package,
`extensions/data_updaters/gradient/index.ts`. The adapter preserves legacy
gradient opacity, guards repeated installation, and avoids importing the
unrelated gesture integration from the extensions barrel.

Source artifact: https://registry.npmjs.org/fabric/-/fabric-7.4.0.tgz

Artifact SRI: `sha512-NalYDc3eifTl1C33zryQwpH6+XA/2ClxQrH9vkASkZw3tbkRmorpikhYMmxhUTmi7O3e9ODz0vOT8qfaCh9IVA==`

Original source SHA-256: `9576b59472a63a6698e07f573fcbc437642f276aae2784d7054004d0ed0295d6`

Original LICENSE SHA-256: `eda412692b7398293a049ecf913319da26eb8f7fe27f10709821dd187b517e0b`

## MIT License

Copyright (c) 2008-2015 Printio (Juriy Zaytsev, Maxim Chernyak)
Copyright (c) 2016-present Andrea Bogazzi, Shachar Nen and Fabric.js contributors (https://github.com/fabricjs/fabric.js/graphs/contributors)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
