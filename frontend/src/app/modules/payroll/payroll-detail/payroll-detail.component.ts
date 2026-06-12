import { Component, OnInit, ChangeDetectionStrategy, signal } from '@angular/core';
import { CommonModule }  from '@angular/common';
import { RouterModule, ActivatedRoute } from '@angular/router';
import { TableModule }   from 'primeng/table';
import { ButtonModule }  from 'primeng/button';
import { TagModule }     from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { PayrollService } from '../../../shared/models/payroll.service';

@Component({
  selector: 'app-payroll-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './payroll-detail.component.css',
  imports: [CommonModule, RouterModule, TableModule, ButtonModule, TagModule, TooltipModule],
  templateUrl: './payroll-detail.component.html',
})
export class PayrollDetailComponent implements OnInit {
  period     = signal<any>(null);
  details    = signal<any[]>([]);
  summary    = signal<{ total_to_employees: number; total_to_iess: number; total_employer_cost: number } | null>(null);
  loading    = signal(false);
  generating = signal(false);

  constructor(private svc: PayrollService, private route: ActivatedRoute) {}

  ngOnInit() {
    const id = this.route.snapshot.params['id'];
    this.loading.set(true);
    this.svc.getPeriod(id).subscribe((r) => { this.period.set(r.data); this.loading.set(false); });
    this.loadDetails(id);
  }

  private loadDetails(id: string) {
    this.svc.listDetails(id).subscribe((r) => {
      this.details.set(r.data.items ?? r.data);
      this.summary.set(r.data.summary ?? null);
    });
  }

  generate() {
    const id = this.route.snapshot.params['id'];
    this.generating.set(true);
    this.svc.generate(id).subscribe({
      next: () => { this.loadDetails(id); this.generating.set(false); },
      error: () => this.generating.set(false),
    });
  }

  close() {
    const id = this.route.snapshot.params['id'];
    this.svc.close(id).subscribe(() => this.svc.getPeriod(id).subscribe((r) => this.period.set(r.data)));
  }

  downloadPdf(detailId: string) {
    this.svc.downloadPdf(detailId).subscribe((blob) => {
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    });
  }
}
