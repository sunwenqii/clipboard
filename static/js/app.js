var state = { currentTextId: null, currentPassword: null, isProtected: false };
var SESSION_TOKEN = document.querySelector('meta[name="session-token"]').content;
var _submitting = false;

function apiFetch(url, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers || {}, { 'X-SESSION-TOKEN': SESSION_TOKEN });
    return fetch(url, options);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function showNotification(msg, isError) {
    var el = document.getElementById('notification');
    var stack = el._stack || [];
    stack.push({ msg: msg, isError: isError, ts: Date.now() });
    el._stack = stack;
    if (el._active) return;
    el._active = true;
    function next() {
        if (!el._stack || el._stack.length === 0) {
            el._active = false;
            el.style.transform = 'translateY(-100px)';
            el.style.opacity = '0';
            return;
        }
        var item = el._stack.shift();
        el.textContent = item.msg;
        el.className = 'notification fixed top-4 right-4 px-6 py-3 rounded-lg shadow-lg z-50 ' +
            (item.isError ? 'bg-red-500 text-white' : 'bg-green-600 text-white');
        el.style.transform = 'translateY(0)';
        el.style.opacity = '1';
        el._timer = setTimeout(function () {
            next();
        }, 1800);
    }
    clearTimeout(el._timer);
    next();
}

function openModal(id) {
    document.getElementById(id).classList.add('open');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('open');
}

function closeTextModal() {
    closeModal('textModal');
    state.currentTextId = null;
    state.currentPassword = null;
    state.isProtected = false;
}

function renderHistory(history) {
    var container = document.getElementById('historyContainer');
    if (!history || history.length === 0) {
        container.innerHTML = '<div class="flex items-center justify-center py-16 text-gray-400"><i class="fa fa-inbox mr-2 text-2xl"></i><span>暂无记录</span></div>';
        return;
    }

    container.innerHTML = '';
    history.forEach(function (item) {
        var el = document.createElement('div');
        el.className = 'bg-white rounded-lg shadow p-4 border-l-4 ' +
            (item.protected ? 'border-danger' : 'border-primary') +
            ' hover:shadow-md transition-shadow';
        el.style.opacity = '0';

        var preview = item.protected
            ? '<span class="text-gray-500"><i class="fa fa-lock mr-1"></i>受密码保护</span>'
            : (item.content && item.content.length > 120
                ? escapeHtml(item.content.substring(0, 120)) + '...'
                : escapeHtml(item.content || ''));

        var timeStr = new Date(item.timestamp).toLocaleString();

        el.innerHTML =
            '<div class="flex flex-wrap justify-between items-start mb-2 gap-2">' +
                '<div>' +
                    '<span class="text-sm text-gray-500">' + timeStr + '</span>' +
                    (item.protected ? '<span class="ml-2 text-xs bg-red-50 text-red-500 px-2 py-0.5 rounded">加密</span>' : '') +
                '</div>' +
                '<span class="text-xs text-gray-400"><i class="fa fa-user-secret mr-1"></i>' + escapeHtml(item.ip_address || '') + '</span>' +
            '</div>' +
            '<div class="text-gray-800 text-sm break-words cursor-pointer hover:bg-gray-50 p-2 rounded transition-colors" data-id="' + item.id + '" data-protected="' + item.protected + '">' +
                preview +
            '</div>';

        container.appendChild(el);

        requestAnimationFrame(function () {
            el.style.transition = 'opacity 0.3s ease';
            el.style.opacity = '1';
        });

        el.querySelector('[data-id]').addEventListener('click', function () {
            viewText(parseInt(this.dataset.id), this.dataset.protected === 'true');
        });
    });
}

function loadHistory() {
    var container = document.getElementById('historyContainer');
    container.innerHTML = '<div class="flex items-center justify-center py-12"><div class="spinner"></div></div>';

    apiFetch('/api/history')
        .then(function (res) {
            if (res.status === 401) throw new Error('Unauthorized');
            return res.json();
        })
        .then(function (data) {
            if (data && data.success) {
                var sorted = (data.history || []).sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
                renderHistory(sorted);
                document.getElementById('historyCount').textContent = sorted.length;
                var btn = document.getElementById('clearAllBtn');
                if (sorted.length > 0) {
                    btn.classList.remove('hidden');
                } else {
                    btn.classList.add('hidden');
                }
            }
        })
        .catch(function (err) {
            console.error('loadHistory:', err);
            showNotification('加载历史记录失败', true);
            container.innerHTML = '<div class="flex items-center justify-center py-16 text-gray-400"><i class="fa fa-exclamation-triangle mr-2"></i><span>加载失败</span></div>';
        });
}

function loadTextContent(id, password) {
    return new Promise(function (resolve, reject) {
        var isPost = !!password;
        var options = {
            method: isPost ? 'POST' : 'GET',
            headers: { 'Content-Type': 'application/json' },
        };
        if (isPost) {
            options.body = JSON.stringify({ password: password });
        }
        apiFetch('/api/text/' + id, options)
            .then(function (res) {
                if (res.status === 401) {
                    showNotification('密码错误', true);
                    reject(new Error('Unauthorized'));
                    return;
                }
                if (res.status === 404) {
                    showNotification('记录不存在', true);
                    reject(new Error('Not found'));
                    return;
                }
                return res.json();
            })
            .then(function (data) {
                if (!data || !data.success) {
                    showNotification(data && data.message || '操作失败', true);
                    reject(new Error('Failed'));
                    return;
                }
                resolve(data.content);
            })
            .catch(function (err) { reject(err); });
    });
}

function viewText(id, isProtected) {
    state.currentTextId = id;
    state.isProtected = isProtected;
    state.currentPassword = null;

    document.getElementById('passwordPrompt').classList.add('hidden');
    document.getElementById('modalActions').classList.add('hidden');
    document.getElementById('modalPasswordInput').value = '';

    openModal('textModal');

    if (isProtected) {
        document.getElementById('textContent').classList.add('hidden');
        document.getElementById('passwordPrompt').classList.remove('hidden');
        return;
    }

    document.getElementById('textContent').classList.remove('hidden');
    document.getElementById('textBody').classList.remove('show');
    document.getElementById('textBody').textContent = '';
    loadTextContent(id, null)
        .then(function (content) {
            showTextWithAnimation(content);
            document.getElementById('modalActions').classList.remove('hidden');
        })
        .catch(function () { closeTextModal(); });
}

function showTextWithAnimation(content) {
    var body = document.getElementById('textBody');
    body.textContent = content;
    requestAnimationFrame(function () {
        body.classList.add('show');
    });
}

function setSubmitting(active) {
    _submitting = active;
    var btn = document.getElementById('saveBtn');
    document.getElementById('saveBtnText').className = active ? 'hidden' : '';
    document.getElementById('saveBtnLoading').className = active ? '' : 'hidden';
    btn.disabled = active;
}

function setupEventListeners() {
    document.getElementById('textForm').addEventListener('submit', function (e) {
        e.preventDefault();
        if (_submitting) return;
        var text = document.getElementById('textInput').value.trim();
        var password = document.getElementById('passwordInput').value.trim();
        if (!text) {
            showNotification('请输入文本内容', true);
            return;
        }
        setSubmitting(true);
        apiFetch('/api/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: text, password: password })
        })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (data.success) {
                showNotification('文本保存成功');
                document.getElementById('textInput').value = '';
                document.getElementById('passwordInput').value = '';
                localStorage.removeItem('clipboard_draft');
                loadHistory();
            } else {
                showNotification(data.message || '保存失败', true);
            }
        })
        .catch(function () { showNotification('网络错误，请检查', true); })
        .finally(function () { setSubmitting(false); });
    });

    document.getElementById('generatePassword').addEventListener('click', function () {
        var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
        var pw = '';
        for (var i = 0; i < 6; i++) pw += chars[Math.floor(Math.random() * chars.length)];
        document.getElementById('passwordInput').value = pw;
        showNotification('已生成随机密码: ' + pw);
    });

    document.getElementById('verifyPassword').addEventListener('click', function () {
        var pw = document.getElementById('modalPasswordInput').value.trim();
        if (!pw) { showNotification('请输入密码', true); return; }
        if (!state.currentTextId) return;

        document.getElementById('textContent').classList.remove('hidden');
        document.getElementById('textBody').classList.remove('show');
        document.getElementById('textBody').textContent = '';
        loadTextContent(state.currentTextId, pw)
            .then(function (content) {
                state.currentPassword = pw;
                document.getElementById('passwordPrompt').classList.add('hidden');
                showTextWithAnimation(content);
                document.getElementById('modalActions').classList.remove('hidden');
            })
            .catch(function () {});
    });

    document.getElementById('closeTextModal').addEventListener('click', closeTextModal);

    document.getElementById('copyTextBtn').addEventListener('click', function () {
        var text = document.getElementById('textBody').textContent;
        if (!text) { showNotification('没有可复制的文本', true); return; }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                showNotification('已复制到剪贴板');
            }).catch(function () { showNotification('复制失败', true); });
        } else {
            try {
                var ta = document.createElement('textarea');
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                showNotification('已复制到剪贴板');
            } catch (e) {
                showNotification('复制失败', true);
            }
        }
    });

    document.getElementById('deleteTextBtn').addEventListener('click', function () {
        closeModal('textModal');
        setTimeout(function () { openModal('deleteModal'); }, 200);
    });

    document.getElementById('cancelDelete').addEventListener('click', function () {
        closeModal('deleteModal');
        if (state.currentTextId) viewText(state.currentTextId, state.isProtected);
    });

    document.getElementById('confirmDelete').addEventListener('click', function () {
        if (!state.currentTextId) return;
        var options = { method: 'POST' };
        if (state.isProtected && state.currentPassword) {
            options.headers = { 'Content-Type': 'application/json' };
            options.body = JSON.stringify({ password: state.currentPassword });
        }
        apiFetch('/api/delete/' + state.currentTextId, options)
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (data.success) {
                    showNotification('记录已删除');
                    closeModal('deleteModal');
                    closeTextModal();
                    loadHistory();
                } else {
                    showNotification(data.message || '删除失败', true);
                    closeModal('deleteModal');
                }
            })
            .catch(function () { showNotification('网络错误，请检查', true); });
    });

    document.getElementById('clearAllBtn').addEventListener('click', function () {
        document.getElementById('adminPasswordInput').value = '';
        openModal('clearAllModal');
    });

    document.getElementById('cancelClearAll').addEventListener('click', function () {
        closeModal('clearAllModal');
    });

    document.getElementById('confirmClearAll').addEventListener('click', function () {
        var pw = document.getElementById('adminPasswordInput').value.trim();
        if (!pw) { showNotification('请输入管理员密码', true); return; }
        apiFetch('/api/clear-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ admin_password: pw })
        })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (data.success) {
                showNotification('所有记录已清空');
                closeModal('clearAllModal');
                loadHistory();
            } else {
                showNotification(data.message || '清空失败', true);
            }
        })
        .catch(function () { showNotification('网络错误，请检查', true); });
    });

    [document.getElementById('textModal'), document.getElementById('deleteModal'), document.getElementById('clearAllModal')].forEach(function (modal) {
        modal.addEventListener('click', function (e) {
            if (e.target === this) {
                if (this.id === 'textModal') closeTextModal();
                else closeModal(this.id);
            }
        });
    });
}

function setupPasswordToggles() {
    [
        ['passwordInput', 'togglePassword'],
        ['modalPasswordInput', 'toggleModalPassword'],
        ['adminPasswordInput', 'toggleAdminPassword']
    ].forEach(function (pair) {
        var input = document.getElementById(pair[0]);
        var btn = document.getElementById(pair[1]);
        if (!input || !btn) return;
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            var type = input.type === 'password' ? 'text' : 'password';
            input.type = type;
            btn.querySelector('i').className = type === 'password' ? 'fa fa-eye-slash' : 'fa fa-eye';
        });
    });
}

function setupPasswordEnterKeys() {
    var modalPw = document.getElementById('modalPasswordInput');
    if (modalPw) {
        modalPw.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('verifyPassword').click();
            }
        });
    }
    var adminPw = document.getElementById('adminPasswordInput');
    if (adminPw) {
        adminPw.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('confirmClearAll').click();
            }
        });
    }
}

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            var modals = [
                document.getElementById('textModal'),
                document.getElementById('deleteModal'),
                document.getElementById('clearAllModal')
            ];
            for (var i = 0; i < modals.length; i++) {
                if (modals[i] && modals[i].classList.contains('open')) {
                    e.preventDefault();
                    if (modals[i].id === 'textModal') closeTextModal();
                    else closeModal(modals[i].id);
                    return;
                }
            }
        }
        if (e.ctrlKey && e.key === 'Enter') {
            var textInput = document.getElementById('textInput');
            if (textInput && document.activeElement === textInput) {
                e.preventDefault();
                document.getElementById('saveBtn').click();
            }
        }
    });
}

function setupDraftSave() {
    var draft = localStorage.getItem('clipboard_draft');
    if (draft) {
        document.getElementById('textInput').value = draft;
    }
    var draftTimer;
    document.getElementById('textInput').addEventListener('input', function () {
        clearTimeout(draftTimer);
        var val = this.value;
        draftTimer = setTimeout(function () {
            if (val) {
                localStorage.setItem('clipboard_draft', val);
            } else {
                localStorage.removeItem('clipboard_draft');
            }
        }, 500);
    });
}

document.addEventListener('DOMContentLoaded', function () {
    loadHistory();
    setupEventListeners();
    setupPasswordToggles();
    setupPasswordEnterKeys();
    setupKeyboardShortcuts();
    setupDraftSave();
});
