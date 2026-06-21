import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

interface NavItem {
  label: string; icon: string; route: string;
  roles?: string[]; separator?: boolean;
  exact?: boolean;
  children?: NavItem[];
}

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule, RouterModule],
  template: `
    <nav class="sidebar">
      <div class="sidebar-header">
        <span class="sidebar-logo">RRHH<span class="accent">Admin</span></span>
      </div>
      <ul class="sidebar-menu">
        @for (item of visibleItems; track item.route) {
          @if (item.separator) {
            <li class="menu-separator"></li>
          } @else if (item.children) {
            <li>
              <a class="menu-item menu-parent" [class.active]="isChildActive(item)"
                 (click)="toggleMenu(item)">
                <i [class]="'pi ' + item.icon"></i>
                <span>{{ item.label }}</span>
                <i class="pi pi-chevron-down chevron" [class.rotated]="isExpanded(item)"></i>
              </a>
              @if (isExpanded(item)) {
                <ul class="submenu">
                  @for (child of item.children; track child.route) {
                    <li>
                      <a [routerLink]="child.route" routerLinkActive="active"
                         [routerLinkActiveOptions]="child.exact ? { exact: true } : { exact: false }"
                         class="menu-item submenu-item">
                        <i [class]="'pi ' + child.icon"></i>
                        <span>{{ child.label }}</span>
                      </a>
                    </li>
                  }
                </ul>
              }
            </li>
          } @else {
            <li>
              <a [routerLink]="item.route" routerLinkActive="active" class="menu-item">
                <i [class]="'pi ' + item.icon"></i>
                <span>{{ item.label }}</span>
              </a>
            </li>
          }
        }
      </ul>
      <div class="sidebar-footer">
        <span class="user-info">{{ auth.currentUser?.email }}</span>
        <span class="role-badge">{{ auth.role }}</span>
      </div>
    </nav>
  `,
  styles: [`
    .sidebar { width: 240px; height: 100vh; position: sticky; top: 0; overflow-y: auto; background: #1e3a5f; color: white; display: flex; flex-direction: column; flex-shrink: 0; }
    .sidebar-header { padding: 1.5rem 1rem; border-bottom: 1px solid rgba(255,255,255,.1); }
    .sidebar-logo { font-size: 1.4rem; font-weight: 700; letter-spacing: 1px; }
    .sidebar-logo .accent { color: #60a5fa; }
    .sidebar-menu { list-style: none; padding: .5rem 0; margin: 0; flex: 1; }
    .menu-item { display: flex; align-items: center; gap: .75rem; padding: .7rem 1.25rem; color: rgba(255,255,255,.8); text-decoration: none; border-radius: 6px; margin: 2px 8px; transition: all .15s; font-size: .92rem; cursor: pointer; }
    .menu-item:hover, .menu-item.active { background: rgba(255,255,255,.12); color: white; }
    .menu-item.active { background: #3b82f6; color: white; }
    .menu-parent { user-select: none; }
    .menu-parent .chevron { margin-left: auto; font-size: .75rem; transition: transform .2s; }
    .menu-parent .chevron.rotated { transform: rotate(-180deg); }
    .submenu { list-style: none; padding: 0; margin: 0; }
    .submenu-item { padding: .55rem 1.25rem .55rem 2.75rem; font-size: .88rem; margin: 1px 8px; }
    .menu-separator { height: 1px; background: rgba(255,255,255,.1); margin: .5rem 1rem; }
    .sidebar-footer { padding: 1rem; border-top: 1px solid rgba(255,255,255,.1); font-size: .78rem; }
    .user-info { display: block; color: rgba(255,255,255,.7); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .role-badge { display: inline-block; margin-top: 4px; padding: 2px 8px; background: #3b82f6; border-radius: 10px; font-size: .7rem; font-weight: 600; }
  `],
})
export class SidebarComponent implements OnInit {
  auth   = inject(AuthService);
  router = inject(Router);

  private expanded = new Set<string>();

  private readonly ALL_ITEMS: (NavItem & { exact?: boolean })[] = [
    { label: 'Dashboard', icon: 'pi-home', route: '/dashboard' },
    { label: 'Empleados', icon: 'pi-users', route: '/employees' },
    { label: '', icon: '', route: '', separator: true },
    { label: 'Nómina',                icon: 'pi-money-bill', route: '/payroll',           roles: ['ADMIN', 'HR'] },
    { label: 'Obligaciones Laborales', icon: 'pi-briefcase',  route: '/labor-obligations', roles: ['ADMIN', 'HR'] },
    { label: 'Vacaciones',            icon: 'pi-sun',        route: '/vacations' },
    { label: 'Turnos',                icon: 'pi-calendar',   route: '/shifts' },
    { label: '', icon: '', route: '', separator: true },
    { label: 'Comunicados', icon: 'pi-megaphone', route: '/announcements', roles: ['ADMIN', 'HR'] },
    { label: '', icon: '', route: '', separator: true },
    {
      label: 'Condominio', icon: 'pi-building', route: '/condominium', roles: ['ADMIN', 'HR'],
      children: [
        { label: 'Dashboard',       icon: 'pi-home',              route: '/condominium',             exact: true } as any,
        { label: 'Propietarios',    icon: 'pi-users',             route: '/condominium/owners' },
        { label: 'Períodos',        icon: 'pi-calendar',          route: '/condominium/periods' },
        { label: 'Fondos Reserva',  icon: 'pi-wallet',            route: '/condominium/funds' },
        { label: 'Provisiones',     icon: 'pi-shield',            route: '/condominium/provisions' },
        { label: 'Morosidad',       icon: 'pi-exclamation-circle',route: '/condominium/morosidad' },
        { label: 'Reportes',        icon: 'pi-chart-bar',         route: '/condominium/reports' },
        { label: 'Configuración',   icon: 'pi-cog',               route: '/condominium/config' },
      ],
    },
  ];

  ngOnInit() {
    // Auto-expand parent if a child route is currently active
    for (const item of this.ALL_ITEMS) {
      if (item.children?.some(c => this.router.url.startsWith(c.route))) {
        this.expanded.add(item.route);
      }
    }
  }

  get visibleItems(): NavItem[] {
    return this.ALL_ITEMS.filter(item => {
      if (item.separator) return true;
      if (!item.roles) return true;
      return this.auth.hasRole(...(item.roles as any));
    });
  }

  toggleMenu(item: NavItem) {
    this.expanded.has(item.route)
      ? this.expanded.delete(item.route)
      : this.expanded.add(item.route);
  }

  isExpanded(item: NavItem): boolean {
    return this.expanded.has(item.route);
  }

  isChildActive(item: NavItem): boolean {
    return item.children?.some(c => this.router.url.startsWith(c.route)) ?? false;
  }
}
