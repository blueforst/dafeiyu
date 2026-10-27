#!/usr/bin/python3
import subprocess,pathlib
subprocess.run(['docker','compose','exec','-T','app','node','dist/cli.js','backup'],cwd='/srv/role-workflow',check=True)
backups=sorted(pathlib.Path('/var/lib/role-workflow/app/backups').glob('workflow-*.sqlite'))
for p in backups[:-7]:p.unlink()
