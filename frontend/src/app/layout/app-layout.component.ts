import { Component, computed, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import { SidebarComponent } from './sidebar/sidebar.component';
import { NavbarComponent } from './navbar/navbar.component';

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [RouterOutlet, CommonModule, SidebarComponent, NavbarComponent],
  template: `
    <div class="layout-wrapper">
      <app-sidebar />
      <div class="layout-main">
        <app-navbar />
        <div class="layout-content">
          <router-outlet />
        </div>
      </div>
    </div>
  `,
  styles: [`
    .layout-wrapper { display: flex; min-height: 100vh; background: #f8f9fa; }
    .layout-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .layout-content { flex: 1; padding: 1.5rem; overflow-y: auto; }
  `],
})
export class AppLayoutComponent {}
