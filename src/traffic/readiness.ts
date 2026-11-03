// 使用真实代理向本地随机端口请求，验证插件剥离内部头；不访问公网或写入业务证据。
// 错误示范：只检查模块版本和监听端口，无法识别插件缺失请求钩子。
export const trafficReadinessProbe = `
import sys, threading, uuid, http.client
from http.server import BaseHTTPRequestHandler, HTTPServer
sys.path.insert(0, '/opt/relay')
from traffic_context import CONTEXT_VERSION, HEADER, encode_context
assert CONTEXT_VERSION == 1
nonce = str(uuid.uuid4())
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        clean = not self.headers.get_all(HEADER)
        self.send_response(200 if clean else 409)
        self.end_headers()
        self.wfile.write(nonce.encode())
    def log_message(self, *args):
        pass
server = HTTPServer(('127.0.0.1', 0), Handler)
server.timeout = 2
worker = threading.Thread(target=server.handle_request, daemon=True)
worker.start()
connection = http.client.HTTPConnection('127.0.0.1', 18080, timeout=2)
try:
    connection.request('GET', 'http://127.0.0.1:%d/' % server.server_port,
                       headers={HEADER: encode_context('curl')})
    response = connection.getresponse()
    assert response.status == 200 and response.read(128).decode() == nonce
finally:
    connection.close()
    worker.join(timeout=2)
    server.server_close()
`;
