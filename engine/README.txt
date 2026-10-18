Optional: a native Stockfish for more speed
==========================================

The trainer already ships with Stockfish compiled to WebAssembly (installed by
npm), so you do not need anything here.

If you want the full native engine (several times faster on most laptops):

1. Download Stockfish for Windows from https://stockfishchess.org/download/
   ("AVX2" is right for most laptops from the last ten years; pick "x86-64"
   if AVX2 does not start).
2. Unzip it and copy the .exe into this folder, e.g.
   engine\stockfish-windows-x86-64-avx2.exe
3. Restart the trainer. The console line "Engine: native (...)" confirms it.

You can also point at an engine elsewhere with the STOCKFISH_PATH environment
variable.
