# c-leaf-wrm-seed42

The app ships `c-leaf-wrm-seed42.bin`, a flat `SEKIRW01` model selected by the
`sekirei-weight` Stage 2 evaluation. Its SHA-256 is
`807c18da03521414a8c75dfe51dd4de2caf8e9ec4909320826eac12b66852eab` and its
size is 1,305,356 bytes. The native bridge verifies both values, the format
magic, and Sekirei's parser before loading it.

The runtime is Sekirei `v0.3.36` at commit
`aeb6ea30d58f93cad84ffe98bc13441feb807fa8`; see [the native notice](../../native/sekirei/NOTICE)
and [the model notice](NOTICE.txt) for provenance and license boundaries.
The model is a separate data artifact and does not inherit Sekirei's
MIT/Apache-2.0 software license automatically. The teacher executable,
teacher weight, original `nn.bin`, and GPL teacher source are not included.
