"""Run inside the upstream validation image against a disposable Linux catalog volume."""
import json
import os
from pathlib import Path
import subprocess
import sys

import yaml

os.chdir('/workspace')
sys.path.insert(0, '/workspace/.github/scripts')
import common
import generate_metadata

# A named volume keeps atomic metadata writes on Linux and lets nested renderer
# containers see the same workspace on Docker Desktop as well as Linux hosts.
original_command = common.catalog_container_cmd


def catalog_command(options, command):
    args = original_command(options, command)
    mount = '-v=/workspace:/workspace'
    args[args.index(mount)] = f'-v={os.environ["CATALOG_VOLUME"]}:/workspace'
    return args


common.catalog_container_cmd = catalog_command
app_path = Path('ix-dev/community/plex-repairman')
results = Path('/workspace/check-results')
results.mkdir(exist_ok=True)
app = generate_metadata.load_app('community', app_path)
generate_metadata.update_app(app, bump_version=False, set_date_added=False)

for values_path in sorted((app_path / 'templates/test_values').glob('*.yaml')):
    subprocess.run(['apps_render_app', 'render', f'--path=/workspace/{app_path}', f'--values=/workspace/{values_path}'], check=True)
    rendered_path = app_path / 'templates/rendered/docker-compose.yaml'
    rendered = yaml.safe_load(rendered_path.read_text())
    service = rendered['services']['plex-repairman']
    assert service['read_only'] is True
    assert service['user'] != '0:0'
    assert service['cap_drop'] == ['ALL']
    assert 'no-new-privileges=true' in service['security_opt']
    assert service['environment']['CONFIG_DIR'] == '/config'
    assert not any('/var/run/docker.sock' in str(mount) for mount in service.get('volumes', []))
    (results / f'{values_path.stem}.json').write_text(json.dumps(rendered, indent=2) + '\n')

# Exercise the same changed-app validation used by the upstream catalog CI.
subprocess.run(['git', 'init', '--initial-branch=master'], check=True, capture_output=True)
subprocess.run(['git', '-c', 'user.email=validation@localhost', '-c', 'user.name=Validation', 'commit', '--allow-empty', '-m', 'baseline'], check=True, capture_output=True)
subprocess.run(['git', 'switch', '-c', 'app'], check=True, capture_output=True)
subprocess.run(['git', 'add', str(app_path)], check=True)
subprocess.run(['git', '-c', 'user.email=validation@localhost', '-c', 'user.name=Validation', 'commit', '-m', 'Validate Plex Repairman'], check=True, capture_output=True)
subprocess.run(['apps_dev_charts_validate', 'validate', '--path', '/workspace'], check=True)
print('Upstream catalog metadata, schema and both storage templates passed.')
