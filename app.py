import os
import json
import hashlib
import secrets
import logging
import time
import threading
from datetime import datetime
from logging.handlers import RotatingFileHandler
from dotenv import load_dotenv
from flask import Flask, request, jsonify, render_template
from werkzeug.middleware.proxy_fix import ProxyFix

load_dotenv()

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(APP_DIR, 'data.json')
LOG_FILE = os.path.join(APP_DIR, 'app.log')

ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'admin123')
HASH_SALT = os.environ.get('HASH_SALT', 'my-secret-salt')
ISSUED_TOKENS = {}
TOKEN_TTL = int(os.environ.get('SESSION_TOKEN_TTL', '3600'))
PROXY_COUNT = int(os.environ.get('PROXY_COUNT', '1'))
MAX_TEXT_LENGTH = int(os.environ.get('MAX_TEXT_LENGTH', '524288'))
_data_lock = threading.Lock()

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=PROXY_COUNT, x_proto=PROXY_COUNT, x_host=PROXY_COUNT, x_port=PROXY_COUNT)

handler = RotatingFileHandler(LOG_FILE, maxBytes=5 * 1024 * 1024, backupCount=3, encoding='utf-8')
handler.setFormatter(logging.Formatter('%(asctime)s - %(message)s', datefmt='%Y-%m-%d %H:%M:%S'))
logging.basicConfig(level=logging.INFO, handlers=[handler])


def init_data():
    """创建数据文件（如果不存在）"""
    if not os.path.exists(DATA_FILE):
        with open(DATA_FILE, 'w', encoding='utf-8') as f:
            json.dump([], f, ensure_ascii=False)


def load_data():
    """从 JSON 文件读取所有记录"""
    init_data()
    try:
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, FileNotFoundError):
        with open(DATA_FILE, 'w', encoding='utf-8') as f:
            json.dump([], f, ensure_ascii=False)
        return []


def save_data(data):
    """通过临时文件原子写入，防止写失败导致数据损坏"""
    tmp_file = DATA_FILE + '.tmp'
    with open(tmp_file, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    try:
        os.replace(tmp_file, DATA_FILE)
    except Exception:
        try:
            os.remove(tmp_file)
        except Exception:
            pass


def hash_password(password):
    """SHA-256 + 盐值哈希"""
    return hashlib.sha256((password + HASH_SALT).encode()).hexdigest()


def generate_session_token():
    """生成前端会话令牌"""
    token = secrets.token_hex(16)
    ISSUED_TOKENS[token] = time.time()
    return token


def is_valid_session_token(token):
    """验证会话令牌是否有效且未过期"""
    if not token:
        return False
    ts = ISSUED_TOKENS.get(token)
    if not ts:
        return False
    if time.time() - ts > TOKEN_TTL:
        try:
            del ISSUED_TOKENS[token]
        except KeyError:
            pass
        return False
    return True


def cleanup_expired_tokens():
    """清理过期令牌"""
    now = time.time()
    expired = [k for k, v in list(ISSUED_TOKENS.items()) if now - v > TOKEN_TTL]
    for k in expired:
        ISSUED_TOKENS.pop(k, None)


def get_client_ip():
    """从代理头或直连获取客户端 IP"""
    xff = request.headers.get('X-Forwarded-For', '')
    if xff:
        try:
            return next(ip.strip() for ip in xff.split(',') if ip.strip())
        except StopIteration:
            pass
    xr = request.headers.get('X-Real-IP')
    if xr:
        return xr.strip()
    cf = request.headers.get('CF-Connecting-IP')
    if cf:
        return cf.strip()
    return request.remote_addr or ''


@app.route('/')
def index():
    token = generate_session_token()
    return render_template('index.html', session_token=token)


@app.route('/api/ping')
def ping():
    return jsonify({'success': True, 'message': 'API 运行正常'})


@app.route('/api/save', methods=['POST'])
def save_text():
    try:
        token = request.headers.get('X-SESSION-TOKEN')
        if not is_valid_session_token(token):
            return jsonify({'success': False, 'message': '未授权访问'}), 401
        data = request.get_json(force=True) or {}
        text = (data.get('text') or '').strip()
        password = (data.get('password') or '').strip()
        if not text:
            return jsonify({'success': False, 'message': '文本内容不能为空'})
        if len(text.encode('utf-8')) > MAX_TEXT_LENGTH:
            return jsonify({'success': False, 'message': f'文本内容不能超过 {MAX_TEXT_LENGTH // 1024}KB'})
        client_ip = get_client_ip()
        with _data_lock:
            all_data = load_data()
            text_id = max((int(x.get('id', 0)) for x in all_data), default=0) + 1
            text_data = {
                'id': text_id,
                'content': text,
                'protected': bool(password),
                'password_hash': hash_password(password) if password else None,
                'timestamp': datetime.now().isoformat(),
                'ip_address': client_ip
            }
            all_data.append(text_data)
            save_data(all_data)
        logging.info(f"save, id: {text_id}, ip: {client_ip}")
        return jsonify({'success': True, 'message': '保存成功', 'id': text_id})
    except Exception as e:
        app.logger.error(f"save error: {str(e)}")
        return jsonify({'success': False, 'message': '服务器错误'}), 500


@app.route('/api/history')
def get_history():
    """返回所有记录（受保护条目不返回内容）"""
    try:
        token = request.headers.get('X-SESSION-TOKEN')
        if not is_valid_session_token(token):
            return jsonify({'success': False, 'message': '未授权访问'}), 401
        all_data = load_data()
        history = [
            {
                'id': item.get('id'),
                'content': item.get('content') if not item.get('protected') else '',
                'protected': bool(item.get('protected')),
                'timestamp': item.get('timestamp'),
                'ip_address': item.get('ip_address', '')
            } for item in all_data
        ]
        return jsonify({'success': True, 'history': history})
    except Exception as e:
        app.logger.error(f"history error: {str(e)}")
        return jsonify({'success': False, 'message': '加载历史记录失败'}), 500


@app.route('/api/text/<int:id>', methods=['GET', 'POST'])
def get_text(id):
    """获取单条记录（受保护条目需 POST 提交密码）"""
    try:
        all_data = load_data()
        item = next((x for x in all_data if int(x.get('id', -1)) == id), None)
        if not item:
            return jsonify({'success': False, 'message': '记录不存在'}), 404
        if item.get('protected'):
            if request.method == 'GET':
                return jsonify({'success': False, 'message': '需要密码验证'}), 401
            token = request.headers.get('X-SESSION-TOKEN')
            if not is_valid_session_token(token):
                return jsonify({'success': False, 'message': '未授权访问'}), 401
            data = request.get_json(force=True) or {}
            password = (data.get('password') or '').strip()
            if not password or hash_password(password) != item.get('password_hash'):
                return jsonify({'success': False, 'message': '密码错误'}), 401
            return jsonify({'success': True, 'content': item.get('content', '')})
        token = request.headers.get('X-SESSION-TOKEN')
        if not is_valid_session_token(token):
            return jsonify({'success': False, 'message': '未授权访问'}), 401
        return jsonify({'success': True, 'content': item.get('content', '')})
    except Exception as e:
        app.logger.error(f"get text error: {str(e)}")
        return jsonify({'success': False, 'message': '服务器错误'}), 500


@app.route('/api/delete/<int:id>', methods=['POST'])
def delete_text(id):
    try:
        with _data_lock:
            all_data = load_data()
            item = next((x for x in all_data if int(x.get('id', -1)) == id), None)
            if not item:
                return jsonify({'success': False, 'message': '记录不存在'}), 404
            if item.get('protected'):
                token = request.headers.get('X-SESSION-TOKEN')
                if not is_valid_session_token(token):
                    return jsonify({'success': False, 'message': '未授权访问'}), 401
                data = request.get_json(force=True) or {}
                password = (data.get('password') or '').strip()
                if not password or hash_password(password) != item.get('password_hash'):
                    return jsonify({'success': False, 'message': '密码错误'}), 401
            else:
                token = request.headers.get('X-SESSION-TOKEN')
                if not is_valid_session_token(token):
                    return jsonify({'success': False, 'message': '未授权访问'}), 401
            new_data = [x for x in all_data if int(x.get('id', -1)) != id]
            save_data(new_data)
        logging.info(f"delete, id: {id}, ip: {get_client_ip()}")
        return jsonify({'success': True, 'message': '删除成功'})
    except Exception as e:
        app.logger.error(f"delete error: {str(e)}")
        return jsonify({'success': False, 'message': '服务器错误'}), 500


@app.route('/api/clear-all', methods=['POST'])
def clear_all():
    try:
        data = request.get_json(force=True) or {}
        token = request.headers.get('X-SESSION-TOKEN')
        if not is_valid_session_token(token):
            return jsonify({'success': False, 'message': '未授权访问'}), 401
        admin_pw = (data.get('admin_password') or '').strip()
        if not admin_pw or hash_password(admin_pw) != hash_password(ADMIN_PASSWORD):
            return jsonify({'success': False, 'message': '管理员密码错误'}), 401
        with _data_lock:
            save_data([])
        logging.info(f"clear_all, ip: {get_client_ip()}")
        return jsonify({'success': True, 'message': '所有记录已清空'})
    except Exception as e:
        app.logger.error(f"clear_all error: {str(e)}")
        return jsonify({'success': False, 'message': '服务器错误'}), 500


@app.route('/api/logs')
def get_clean_logs():
    """返回筛选后的操作日志"""
    try:
        token = request.headers.get('X-SESSION-TOKEN')
        if not is_valid_session_token(token):
            return jsonify({'success': False, 'message': '未授权访问'}), 401
        if not os.path.exists(LOG_FILE):
            return jsonify({'success': True, 'logs': []})
        with open(LOG_FILE, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        valid = ['save', 'delete', 'clear_all']
        filtered = [l.strip() for l in lines if any(f" - {p}," in l for p in valid)]
        return jsonify({'success': True, 'logs': filtered})
    except Exception as e:
        app.logger.error(f"logs error: {str(e)}")
        return jsonify({'success': False, 'message': '服务器错误'}), 500


@app.route('/api/ip')
def show_ip():
    return jsonify({'success': True, 'detected_ip': get_client_ip(), 'remote_addr': request.remote_addr})


if __name__ == '__main__':
    init_data()
    debug_mode = os.environ.get('FLASK_DEBUG', os.environ.get('DEBUG', '')).lower() in ('1', 'true', 'yes')
    host = os.environ.get('FLASK_HOST', '0.0.0.0')
    port = int(os.environ.get('FLASK_PORT', '5000'))
    app.run(host=host, port=port, debug=debug_mode)
