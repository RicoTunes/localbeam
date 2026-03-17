import 'dart:ui';
import 'package:flutter/material.dart';
import 'beam_ai_screen.dart';
import 'chat_screen.dart';
import 'settings_screen.dart';
import 'share_screen.dart';
import 'status_screen.dart';

class MainShell extends StatefulWidget {
  const MainShell({super.key});

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> with TickerProviderStateMixin {
  int _index = 0;
  bool _hideBottomNav = false;

  void _onConversationChanged(bool inConversation) {
    setState(() => _hideBottomNav = inConversation);
  }

  late final List<Widget> _pages = [
    const BeamAiScreen(),
    ChatScreen(onConversationChanged: _onConversationChanged),
    const StatusScreen(),
    const ShareScreen(),
    const SettingsScreen(),
  ];

  static const _navItems = <_NavItem>[
    _NavItem(Icons.auto_awesome_outlined, Icons.auto_awesome, 'BEAM AI'),
    _NavItem(Icons.chat_outlined, Icons.chat_rounded, 'Chat'),
    _NavItem(Icons.amp_stories_outlined, Icons.amp_stories_rounded, 'Status'),
    _NavItem(Icons.send_outlined, Icons.send_rounded, 'Share'),
    _NavItem(Icons.tune_outlined, Icons.tune_rounded, 'Settings'),
  ];

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final bottomPadding = MediaQuery.of(context).padding.bottom;

    return Scaffold(
      body: IndexedStack(index: _index, children: _pages),
      extendBody: true,
      bottomNavigationBar: _hideBottomNav ? null : Container(
        margin: EdgeInsets.only(left: 16, right: 16, bottom: bottomPadding + 12),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(28),
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: 24, sigmaY: 24),
            child: Container(
              height: 72,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(28),
                color: isDark
                    ? const Color(0xFF1E293B).withOpacity(0.88)
                    : Colors.white.withOpacity(0.92),
                border: Border.all(
                  color: isDark
                      ? Colors.white.withOpacity(0.08)
                      : Colors.black.withOpacity(0.06),
                  width: 1,
                ),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withOpacity(isDark ? 0.4 : 0.10),
                    blurRadius: 32,
                    offset: const Offset(0, 8),
                    spreadRadius: -4,
                  ),
                  if (isDark)
                    BoxShadow(
                      color: const Color(0xFF667EEA).withOpacity(0.06),
                      blurRadius: 40,
                      offset: const Offset(0, 4),
                    ),
                ],
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: List.generate(_navItems.length, (i) {
                  return _PremiumNavItem(
                    item: _navItems[i],
                    isSelected: _index == i,
                    isDark: isDark,
                    onTap: () => setState(() => _index = i),
                  );
                }),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _NavItem {
  final IconData icon;
  final IconData activeIcon;
  final String label;
  const _NavItem(this.icon, this.activeIcon, this.label);
}

class _PremiumNavItem extends StatefulWidget {
  final _NavItem item;
  final bool isSelected;
  final bool isDark;
  final VoidCallback onTap;

  const _PremiumNavItem({
    required this.item,
    required this.isSelected,
    required this.isDark,
    required this.onTap,
  });

  @override
  State<_PremiumNavItem> createState() => _PremiumNavItemState();
}

class _PremiumNavItemState extends State<_PremiumNavItem>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(milliseconds: 300),
      vsync: this,
    );
    if (widget.isSelected) _controller.forward();
  }

  @override
  void didUpdateWidget(covariant _PremiumNavItem old) {
    super.didUpdateWidget(old);
    if (widget.isSelected && !old.isSelected) {
      _controller.forward(from: 0);
    } else if (!widget.isSelected && old.isSelected) {
      _controller.reverse();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  static const _accent = Color(0xFF667EEA);
  static const _accentEnd = Color(0xFF7C3AED);

  @override
  Widget build(BuildContext context) {
    final inactiveColor = widget.isDark
        ? Colors.white.withOpacity(0.45)
        : Colors.black.withOpacity(0.38);

    return GestureDetector(
      onTap: widget.onTap,
      behavior: HitTestBehavior.opaque,
      child: AnimatedBuilder(
        animation: _controller,
        builder: (context, child) {
          return SizedBox(
            width: 68,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                // Glow dot indicator
                AnimatedContainer(
                  duration: const Duration(milliseconds: 300),
                  curve: Curves.easeOut,
                  height: 3,
                  width: widget.isSelected ? 20 : 0,
                  margin: const EdgeInsets.only(bottom: 6),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(2),
                    gradient: widget.isSelected
                        ? const LinearGradient(colors: [_accent, _accentEnd])
                        : null,
                    boxShadow: widget.isSelected
                        ? [
                            BoxShadow(
                              color: _accent.withOpacity(0.6),
                              blurRadius: 8,
                              spreadRadius: 1,
                            )
                          ]
                        : null,
                  ),
                ),
                // Icon
                AnimatedScale(
                  scale: widget.isSelected ? 1.1 : 1.0,
                  duration: const Duration(milliseconds: 250),
                  curve: Curves.easeOutBack,
                  child: ShaderMask(
                    blendMode: widget.isSelected ? BlendMode.srcIn : BlendMode.dst,
                    shaderCallback: (bounds) => const LinearGradient(
                      colors: [_accent, _accentEnd],
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                    ).createShader(bounds),
                    child: Icon(
                      widget.isSelected ? widget.item.activeIcon : widget.item.icon,
                      size: 24,
                      color: widget.isSelected ? Colors.white : inactiveColor,
                    ),
                  ),
                ),
                const SizedBox(height: 4),
                // Label
                AnimatedDefaultTextStyle(
                  duration: const Duration(milliseconds: 250),
                  style: TextStyle(
                    fontSize: widget.isSelected ? 11.5 : 10.5,
                    fontWeight: widget.isSelected ? FontWeight.w700 : FontWeight.w500,
                    color: widget.isSelected ? _accent : inactiveColor,
                    letterSpacing: widget.isSelected ? 0.3 : 0,
                  ),
                  child: Text(widget.item.label),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

// AnimatedBuilder helper – wraps AnimatedWidget for builder pattern
class AnimatedBuilder extends AnimatedWidget {
  final Widget Function(BuildContext context, Widget? child) builder;
  final Widget? child;

  const AnimatedBuilder({
    super.key,
    required Animation<double> animation,
    required this.builder,
    this.child,
  }) : super(listenable: animation);

  @override
  Widget build(BuildContext context) => builder(context, child);
}

