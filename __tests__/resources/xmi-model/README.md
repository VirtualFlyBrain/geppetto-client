`geppetto_model_loaded.json` and `experiment_loaded.json` are what the live
server (v2.virtualflybrain.org) sent over the websocket for `vfb.xmi` on
9 Oct 2026, the last release that still had a server: the reply to
`load_project_from_url` for `geppetto/build/vfb.json`. `XmiModel.test.js`
checks that the client builds the same model from the same XMI.
