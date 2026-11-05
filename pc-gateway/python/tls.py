"""Application-only TLS certificate. Never install a system CA."""
from pathlib import Path
import datetime,ipaddress,json,sys,os
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
data=json.load(sys.stdin);root=Path(data['directory']);root.mkdir(parents=True,exist_ok=True)
key_path=root/'server-key.pem';cert_path=root/'server-cert.pem'
if not key_path.exists() and not cert_path.exists():
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    subject=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'I SEE YOU local PC')])
    now=datetime.datetime.now(datetime.timezone.utc)
    cert=(x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(minutes=5)).not_valid_after(now+datetime.timedelta(days=365)).add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]+[x509.IPAddress(ipaddress.ip_address(ip)) for ip in data['addresses']]),critical=False).sign(key,hashes.SHA256()))
    for path,content in [(key_path,key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption())),(cert_path,cert.public_bytes(serialization.Encoding.PEM))]:
        fd=os.open(str(path),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'wb') as f:f.write(content);f.flush();os.fsync(f.fileno())
if not key_path.is_file() or not cert_path.is_file():raise RuntimeError('incomplete_tls_files')
cert=x509.load_pem_x509_certificate(cert_path.read_bytes())
print(json.dumps({'fingerprint':cert.fingerprint(hashes.SHA256()).hex()}))
