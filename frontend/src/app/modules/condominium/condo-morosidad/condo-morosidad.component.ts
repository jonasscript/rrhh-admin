import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { CardModule } from 'primeng/card';
import { CondominiumService } from '../../../shared/models/condominium.service';
import { CondoOwner } from '../../../shared/models/models';

@Component({
  selector: 'app-condo-morosidad',
  standalone: true,
  imports: [CommonModule, TableModule, TagModule, CardModule],
  templateUrl: './condo-morosidad.component.html',
  styleUrl: './condo-morosidad.component.css',
})
export class CondoMorosidadComponent implements OnInit {
  private svc = inject(CondominiumService);
  owners: CondoOwner[] = [];
  loading = false;

  get totalMora() { return this.owners.reduce((s, o) => s + Number(o.moraAmount), 0); }

  ngOnInit() {
    this.loading = true;
    this.svc.getMorosidadReport().subscribe({ next: (o) => { this.owners = o; this.loading = false; }, error: () => this.loading = false });
  }
}
