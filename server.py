import http.server
import ssl
import os

server_address = ('0.0.0.0', 8080)
handler_class = http.server.SimpleHTTPRequestHandler
httpd = http.server.HTTPServer(server_address, handler_class)

ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ssl_context.load_cert_chain(keyfile='key.pem', certfile='cert.pem')
httpd.socket = ssl_context.wrap_socket(httpd.socket, server_side=True)

print(f"Serving HTTPS on https://{server_address[0]}:{server_address[1]}")
httpd.serve_forever() 