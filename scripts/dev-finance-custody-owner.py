#!/usr/bin/env python3
"""Owner-side DEV credential custody. Emits only an authenticated encrypted envelope.

The recipient public key comes from the authorized DEV host. No administrative
database credential is transported. An existing Finance secret version is never
rotated. On failure, disable only the version created by this execution.
"""
import argparse, base64, hashlib, json, secrets, subprocess, time
from pathlib import Path
from urllib.parse import quote
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PROJECT = 'xssrfshdrtdfupgqwfdw'
GCP = 'secret-504012'
SECRET = 'bizportal-marketplace-finance-dev-companies'
AAD = b'bizportal-dev-finance-custody-20261117:xssrfshdrtdfupgqwfdw'

def require(ok, code):
    if not ok: raise RuntimeError(code)

def cloud(command, data=None, raw=False):
    result = subprocess.run([args.gcloud, *command, '--project='+GCP, '--quiet', *([] if raw else ['--format=json'])], input=data, text=True, capture_output=True, timeout=45)
    require(result.returncode == 0, 'GCP_OPERATION_FAILED')
    return json.loads(result.stdout) if result.stdout.strip() else None

def main():
    global args
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['prepare','disable'])
    parser.add_argument('--gcloud',required=True)
    parser.add_argument('--public-key')
    parser.add_argument('--version')
    args=parser.parse_args()
    if args.operation == 'disable':
        require(args.version and args.version.isdecimal(), 'VERSION_REQUIRED')
        cloud(['secrets','versions','disable',args.version,'--secret='+SECRET])
        print(json.dumps({'disabledVersion':args.version})); return
    pem=Path(args.public_key).read_bytes()
    public=serialization.load_pem_public_key(pem)
    require(public.key_size >= 3072, 'RECIPIENT_KEY_TOO_SMALL')
    require(not cloud(['secrets','versions','list',SECRET]), 'EXISTING_VERSION_REFUSE_ROTATION')
    source=cloud(['secrets','versions','access','latest','--secret=cst-super-app-development'],raw=True)
    require(source.get('SUPABASE_URL_DEV','').rstrip('/') == 'https://'+PROJECT+'.supabase.co', 'STORAGE_PROJECT_MISMATCH')
    storage={key:source[key] for key in ['SUPABASE_URL_DEV','SUPABASE_SERVICE_ROLE_KEY_DEV']}
    require(all(isinstance(v,str) and len(v)>30 and not any(c in v for c in '\n\r\t \"\'\\$`') for v in storage.values()), 'STORAGE_VALUES_INVALID')
    claims=json.loads(base64.urlsafe_b64decode(storage['SUPABASE_SERVICE_ROLE_KEY_DEV'].split('.')[1]+'=='))
    require(claims.get('ref')==PROJECT and claims.get('role')=='service_role', 'STORAGE_KEY_IDENTITY_MISMATCH')
    bundle={'version':1,'companies':{}}
    for company,role in [('1','bizportal_finance_cst_login_dev'),('3','bizportal_finance_diva_login_dev')]:
        password=secrets.token_urlsafe(48)
        bundle['companies'][company]={'role':role,'databaseUrl':'postgresql://'+role+':'+quote(password,safe='')+'@db.'+PROJECT+'.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=/etc/ssl/certs/supabase-finance-root-2021.crt'}
    version=None
    try:
        receipt=cloud(['secrets','versions','add',SECRET,'--data-file=-'],json.dumps(bundle,separators=(',',':')))
        version=receipt['name'].rsplit('/',1)[-1]
        versions=cloud(['secrets','versions','list',SECRET])
        require(len(versions)==1 and versions[0]['name']==receipt['name'], 'CONCURRENT_SECRET_CHANGE')
        payload={'project':PROJECT,'expires':int(time.time())+7200,'secretVersion':version,'bundle':bundle,'storage':storage}
        key=AESGCM.generate_key(bit_length=256); nonce=secrets.token_bytes(12)
        ciphertext=AESGCM(key).encrypt(nonce,json.dumps(payload,separators=(',',':')).encode(),AAD)
        wrapped=public.encrypt(key,padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),algorithm=hashes.SHA256(),label=AAD))
        b64=lambda value:base64.b64encode(value).decode()
        print(json.dumps({'version':1,'recipientSha256':hashlib.sha256(pem).hexdigest(),'wrappedKey':b64(wrapped),'nonce':b64(nonce),'ciphertext':b64(ciphertext),'secretVersion':version},separators=(',',':')))
    except BaseException:
        if version: cloud(['secrets','versions','disable',version,'--secret='+SECRET])
        raise

if __name__=='__main__':
    try: main()
    except Exception as error:
        print(json.dumps({'ok':False,'code':str(error) if type(error) is RuntimeError else type(error).__name__})); raise SystemExit(1)
