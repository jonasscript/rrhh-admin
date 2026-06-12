import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

interface NavItem {
  label: string; icon: string; route: string;
  roles?: string[]; separator?: boolean;
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
    .sidebar { width: 240px; min-height: 100vh; background: #1e3a5f; color: white; display: flex; flex-direction: column; flex-shrink: 0; }
    .sidebar-header { padding: 1.5rem 1rem; border-bottom: 1px solid rgba(255,255,255,.1); }
    .sidebar-logo { font-size: 1.4rem; font-weight: 700; letter-spacing: 1px; }
    .sidebar-logo .accent { color: #60a5fa; }
    .sidebar-menu { list-style: none; padding: .5rem 0; margin: 0; flex: 1; }
    .menu-item { display: flex; align-items: center; gap: .75rem; padding: .7rem 1.25rem; color: rgba(255,255,255,.8); text-decoration: none; border-radius: 6px; margin: 2px 8px; transition: all .15s; font-size: .92rem; }
    .menu-item:hover, .menu-item.active { background: rgba(255,255,255,.12); color: white; }
    .menu-item.active { background: #3b82f6; color: white; }
    .menu-separator { height: 1px; background: rgba(255,255,255,.1); margin: .5rem 1rem; }
    .sidebar-footer { padding: 1rem; border-top: 1px solid rgba(255,255,255,.1); font-size: .78rem; }
    .user-info { display: block; color: rgba(255,255,255,.7); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .role-badge { display: inline-block; margin-top: 4px; padding: 2px 8px; background: #3b82f6; border-radius: 10px; font-size: .7rem; font-weight: 600; }
  `],
})
export class SidebarComponent {
  auth = inject(AuthService);

  private readonly ALL_ITEMS: NavItem[] = [
    { label: 'Dashboard', icon: 'pi-home', route: '/dashboard' },
    { label: 'Empleados', icon: 'pi-users', route: '/employees' },
    { label: '', icon: '', route: '', separator: true },
    { label: 'Nómina',               icon: 'pi-money-bill',  route: '/payroll',            roles: ['ADMIN', 'HR'] },
    { label: 'Obligaciones Laborales', icon: 'pi-briefcase',   route: '/labor-obligations',  roles: ['ADMIN', 'HR'] },
    { label: 'Vacaciones',            icon: 'pi-sun',         route: '/vacations' },
    { label: 'Turnos', icon: 'pi-calendar', route: '/shifts' },
    { label: '', icon: '', route: '', separator: true },
    { label: 'Comunicados', icon: 'pi-megaphone', route: '/announcements', roles: ['ADMIN', 'HR'] },
    { label: '', icon: '', route: '', separator: true },
    { label: 'Condominio', icon: 'pi-building', route: '/condominium', roles: ['ADMIN', 'HR'] },
  ];

  get visibleItems(): NavItem[] {
    return this.ALL_ITEMS.filter(item => {
      if (item.separator) return true;
      if (!item.roles) return true;
      return this.auth.hasRole(...(item.roles as any));
    });
  }
}
