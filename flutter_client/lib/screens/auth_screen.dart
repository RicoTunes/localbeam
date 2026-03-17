import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/api_service.dart';

class AuthScreen extends StatefulWidget {
  const AuthScreen({super.key});
  @override
  State<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends State<AuthScreen> with SingleTickerProviderStateMixin {
  late TabController _tabCtrl;
  final _formKey = GlobalKey<FormState>();

  // Register fields
  final _nameCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();
  final _passwordCtrl = TextEditingController();

  // Login fields
  final _loginIdCtrl = TextEditingController();
  final _loginPwCtrl = TextEditingController();

  bool _loading = false;
  String? _error;
  bool _obscurePassword = true;
  bool _obscureLoginPw = true;

  @override
  void initState() {
    super.initState();
    _tabCtrl = TabController(length: 2, vsync: this);
    _tabCtrl.addListener(() {
      if (mounted) setState(() => _error = null);
    });
  }

  @override
  void dispose() {
    _tabCtrl.dispose();
    _nameCtrl.dispose();
    _emailCtrl.dispose();
    _phoneCtrl.dispose();
    _passwordCtrl.dispose();
    _loginIdCtrl.dispose();
    _loginPwCtrl.dispose();
    super.dispose();
  }

  Future<void> _register() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() { _loading = true; _error = null; });

    final api = context.read<ApiService>();
    // Try connecting in background (non-blocking) — auth works offline too
    if (!api.isConnected) {
      api.ensureConnected(); // fire-and-forget, don't block
    }
    final result = await api.authRegister(
      name: _nameCtrl.text.trim(),
      email: _emailCtrl.text.trim(),
      phone: _phoneCtrl.text.trim(),
      password: _passwordCtrl.text,
    );

    if (!mounted) return;
    setState(() => _loading = false);
    if (result['error'] != null) {
      setState(() => _error = result['error']);
    } else {
      // Registration success — switch to Login tab
      _loginIdCtrl.text = _emailCtrl.text.trim().isNotEmpty
          ? _emailCtrl.text.trim()
          : _phoneCtrl.text.trim();
      _loginPwCtrl.clear();
      _tabCtrl.animateTo(1);
      setState(() => _error = null);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Account created! Please log in.'),
            backgroundColor: Color(0xFF4ADE80),
          ),
        );
      }
    }
  }

  Future<void> _login() async {
    final id = _loginIdCtrl.text.trim();
    final pw = _loginPwCtrl.text;
    if (id.isEmpty || pw.isEmpty) {
      setState(() => _error = 'Please fill in all fields');
      return;
    }
    setState(() { _loading = true; _error = null; });

    final api = context.read<ApiService>();
    // Try connecting in background (non-blocking) — auth works offline too
    if (!api.isConnected) {
      api.ensureConnected(); // fire-and-forget, don't block
    }
    final result = await api.authLogin(identifier: id, password: pw);

    if (!mounted) return;
    setState(() => _loading = false);
    if (result['error'] != null) {
      setState(() => _error = result['error']);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF0F172A),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                // Logo
                Container(
                  width: 72, height: 72,
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]),
                    borderRadius: BorderRadius.circular(20),
                    boxShadow: [BoxShadow(color: const Color(0xFF667EEA).withOpacity(0.3), blurRadius: 20, offset: const Offset(0, 8))],
                  ),
                  child: const Icon(Icons.send_rounded, color: Colors.white, size: 32),
                ),
                const SizedBox(height: 20),
                const Text('LocalBeam', style: TextStyle(fontSize: 28, fontWeight: FontWeight.w800, color: Colors.white)),
                const SizedBox(height: 4),
                Text('Sign in to chat with friends', style: TextStyle(color: Colors.white.withOpacity(0.5), fontSize: 14)),
                const SizedBox(height: 32),

                // Tabs
                Container(
                  decoration: BoxDecoration(
                    color: const Color(0xFF1E293B),
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: TabBar(
                    controller: _tabCtrl,
                    indicator: BoxDecoration(
                      gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    indicatorSize: TabBarIndicatorSize.tab,
                    dividerColor: Colors.transparent,
                    labelColor: Colors.white,
                    unselectedLabelColor: Colors.white.withOpacity(0.5),
                    labelStyle: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14),
                    tabs: const [
                      Tab(text: 'Register'),
                      Tab(text: 'Login'),
                    ],
                  ),
                ),
                const SizedBox(height: 24),

                // Error
                if (_error != null) ...[
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                    decoration: BoxDecoration(color: const Color(0xFFF87171).withOpacity(0.15), borderRadius: BorderRadius.circular(12)),
                    child: Row(children: [
                      const Icon(Icons.error_outline, color: Color(0xFFF87171), size: 18),
                      const SizedBox(width: 8),
                      Expanded(child: Text(_error!, style: const TextStyle(color: Color(0xFFF87171), fontSize: 13))),
                    ]),
                  ),
                  const SizedBox(height: 16),
                ],

                // Form content
                SizedBox(
                  height: 340,
                  child: TabBarView(
                    controller: _tabCtrl,
                    children: [
                      _buildRegisterForm(),
                      _buildLoginForm(),
                    ],
                  ),
                ),

                // Skip
                TextButton(
                  onPressed: () {
                    // Skip auth — continue as guest
                    Navigator.of(context).pop('skip');
                  },
                  child: Text('Continue as guest', style: TextStyle(color: Colors.white.withOpacity(0.4), fontSize: 13)),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildRegisterForm() {
    return Form(
      key: _formKey,
      child: Column(
        children: [
          _buildTextField(_nameCtrl, 'Full Name', Icons.person_outline, validator: (v) => v != null && v.trim().length >= 2 ? null : 'Min 2 characters'),
          const SizedBox(height: 12),
          _buildTextField(_emailCtrl, 'Email', Icons.email_outlined, keyboardType: TextInputType.emailAddress),
          const SizedBox(height: 12),
          _buildTextField(_phoneCtrl, 'Phone Number', Icons.phone_outlined, keyboardType: TextInputType.phone),
          const SizedBox(height: 12),
          _buildTextField(_passwordCtrl, 'Password', Icons.lock_outline, obscure: _obscurePassword, onToggle: () => setState(() => _obscurePassword = !_obscurePassword),
            validator: (v) => v != null && v.length >= 4 ? null : 'Min 4 characters'),
          const SizedBox(height: 20),
          _buildActionButton('Create Account', _register),
        ],
      ),
    );
  }

  Widget _buildLoginForm() {
    return Column(
      children: [
        _buildTextField(_loginIdCtrl, 'Email or Phone', Icons.alternate_email, keyboardType: TextInputType.emailAddress),
        const SizedBox(height: 12),
        _buildTextField(_loginPwCtrl, 'Password', Icons.lock_outline, obscure: _obscureLoginPw, onToggle: () => setState(() => _obscureLoginPw = !_obscureLoginPw)),
        const SizedBox(height: 20),
        _buildActionButton('Sign In', _login),
      ],
    );
  }

  Widget _buildTextField(TextEditingController ctrl, String hint, IconData icon, {
    TextInputType? keyboardType, bool obscure = false, VoidCallback? onToggle,
    String? Function(String?)? validator,
  }) {
    return TextFormField(
      controller: ctrl,
      style: const TextStyle(color: Colors.white, fontSize: 15),
      keyboardType: keyboardType,
      obscureText: obscure,
      validator: validator,
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: TextStyle(color: Colors.white.withOpacity(0.3)),
        prefixIcon: Icon(icon, color: const Color(0xFF667EEA), size: 20),
        suffixIcon: onToggle != null
            ? IconButton(
                icon: Icon(obscure ? Icons.visibility_off : Icons.visibility, color: Colors.white.withOpacity(0.3), size: 20),
                onPressed: onToggle,
              )
            : null,
        filled: true,
        fillColor: const Color(0xFF1E293B),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide.none),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: const BorderSide(color: Color(0xFF667EEA), width: 1.5)),
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      ),
    );
  }

  Widget _buildActionButton(String label, VoidCallback onTap) {
    return SizedBox(
      width: double.infinity,
      height: 50,
      child: DecoratedBox(
        decoration: BoxDecoration(
          gradient: const LinearGradient(colors: [Color(0xFF667EEA), Color(0xFF7C3AED)]),
          borderRadius: BorderRadius.circular(14),
          boxShadow: [BoxShadow(color: const Color(0xFF667EEA).withOpacity(0.3), blurRadius: 12, offset: const Offset(0, 4))],
        ),
        child: ElevatedButton(
          onPressed: _loading ? null : onTap,
          style: ElevatedButton.styleFrom(
            backgroundColor: Colors.transparent,
            shadowColor: Colors.transparent,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          ),
          child: _loading
              ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : Text(label, style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w700)),
        ),
      ),
    );
  }
}
