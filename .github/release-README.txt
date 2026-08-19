quickstudy standalone binary

Install:
1. Extract this archive.
2. Move `quickstudy` to a directory on PATH (for example `/usr/local/bin`).
3. Ensure it is executable: `chmod +x quickstudy`.
4. Run `quickstudy --help`.

The executable embeds the UI and the container image build contexts. Evals
and experiments are plain directories/modules you author next to your
project (`evals/`, `experiments/`) — the binary imports them at run time.
Docker is still required for container-backed eval runs. See the project
documentation for provider credentials and platform requirements.
