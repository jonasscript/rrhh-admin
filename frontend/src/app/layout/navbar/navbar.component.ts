import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { MenuModule } from 'primeng/menu';
import { AuthService } from '../../core/services/auth.service';
import { MenuItem } from 'primeng/api';

@Component({
  selector: 'app-navbar',
  standalone: true,
  imports: [CommonModule, ButtonModule, MenuModule],
  template: `
    <header class="navbar">
      <div class="navbar-left">
        <span class="page-title">HABBITA</span>
      </div>
      <div class="navbar-right">
        <span class="user-name">{{ auth.currentUser?.email }}</span>
        <p-button
          icon="pi pi-sign-out"
          [rounded]="true"
          [text]="true"
          severity="danger"
          (onClick)="auth.logout()"
          pTooltip="Cerrar sesión"
        />
      </div>
    </header>
  `,
  styles: [`
    .navbar { height: 56px; background: white; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: space-between; padding: 0 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,.05); }
    .page-title { font-weight: 600; color: #1e3a5f; font-size: .95rem; }
    .navbar-right { display: flex; align-items: center; gap: .75rem; }
    .user-name { font-size: .85rem; color: #6b7280; }
  `],
})
export class NavbarComponent {
  auth = inject(AuthService);
}
