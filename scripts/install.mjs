import { execSync } from 'child_process';
execSync('pwd && python3 -m venv env && env/bin/python -m pip install esphome');